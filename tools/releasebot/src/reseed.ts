import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { FixtureSpec, FixtureSpecEntity, FixtureSummary } from "./types.ts";
import { AVAILABLE_ENDPOINTS, executeSpec } from "./stack/paperclip-seed.ts";

const MODEL = "claude-opus-4-7";

const REVISE_SYSTEM_PROMPT = `You are extending a seeded fixture set. Upstream triage has already decided that the failing test needs additional fixture data to render its affordance — your job is to propose the entities, not to second-guess whether extension is appropriate.

Emit a JSON array of NEW \`FixtureSpecEntity\` objects to be APPENDED to the existing seed. The new entities will be POSTed in order, after the original seed has already run, and may reference existing fixtures via \`{{name.field}}\` interpolation.

${AVAILABLE_ENDPOINTS}

Output schema (strict, return ONLY this JSON object — no markdown fences, no commentary):

{
  "rationale": string,                       // 1-3 sentences: what data shape was missing and what these new entities create
  "extensionEntities": [
    {
      "name": string,                        // unique lowercase snake_case, MUST NOT collide with existing fixture names
      "endpoint": string,                    // one of the AVAILABLE_ENDPOINTS
      "body": Record<string, unknown>,       // the request body; may use {{existing.field}}
      "capture": Record<string, string>      // \`{ id: "$.id", ... }\` — capture id at minimum, identifier for issues
    }
    // 1 to 6 entities
  ]
}

Rules:
- DO NOT repeat entities that already exist in the seed. The user message lists their names + captured fields.
- MAY reference existing fixtures by name. Example: \`"endpoint": "POST /api/companies/{{company.id}}/issues"\`.
- DO NOT invent endpoints, fields, or relationships not in AVAILABLE_ENDPOINTS.
- Keep entity bodies realistic — meaningful titles/names that match what the PR's UI is checking for. The point is to make the affordance actually render, not just to add filler.
- If the available endpoints genuinely cannot create the data shape (e.g. it needs an admin role, a stale timestamp, a feature flag, or an external service), output the literal string \`CANNOT_EXTEND\` followed by one sentence explaining the structural blocker. This is the ONLY reason to decline — do not decline based on visual signals (triage already considered those).`;

export interface ReviseResult {
  rationale: string;
  extensionEntities: FixtureSpecEntity[];
}

export async function reviseSeedFromFailure(args: {
  apiKey: string;
  originalSpec: FixtureSpec;
  existingFixtures: FixtureSummary;
  failedStepDescription: string;
  failedStepUrl: string;
  failureSummary: string;
  domHtml: string;
  diff: string;
  /** PNG bytes of the page at moment of failure. Optional — when supplied,
   * sent multimodally so the LLM can visually confirm the page is the one
   * the test intended (vs. a 404 / "not found" / loading state). */
  screenshotBytes?: Uint8Array;
}): Promise<ReviseResult | { cannotExtend: true; reason: string }> {
  const {
    apiKey,
    originalSpec,
    existingFixtures,
    failedStepDescription,
    failedStepUrl,
    failureSummary,
    domHtml,
    diff,
    screenshotBytes,
  } = args;
  const client = new Anthropic({ apiKey });
  const trimmedHtml = stripNoiseFromHtml(domHtml).slice(0, 120_000);
  const truncatedDiff = diff.length > 80_000 ? diff.slice(0, 80_000) + "\n... (truncated)" : diff;

  const existingFixturesBlock = renderFixturesSummary(existingFixtures);
  const originalEntitiesBlock = originalSpec.entities
    .map((e) => `  - ${e.name}: ${e.endpoint} body=${JSON.stringify(e.body)}`)
    .join("\n");

  const userContent = [
    `Failed step: ${failedStepDescription}`,
    `URL: ${failedStepUrl}`,
    "",
    "Failure message (what Playwright reported when the locator did not match):",
    failureSummary,
    "",
    "Existing seeded fixtures (their names and captured fields — your extension may reference these):",
    existingFixturesBlock,
    "",
    "Original fixture spec entities (already POSTed, do NOT repeat):",
    originalEntitiesBlock,
    "",
    "Rendered HTML at moment of failure (script/style/svg stripped). Use this to confirm the affordance is genuinely missing — not just a wrong locator:",
    "```html",
    trimmedHtml,
    "```",
    "",
    "Unified diff for the PR (so you understand what UI surface the test is trying to exercise):",
    "```diff",
    truncatedDiff,
    "```",
  ].join("\n");

  const userBlocks: Anthropic.Messages.ContentBlockParam[] = [
    { type: "text", text: userContent },
  ];
  if (screenshotBytes && screenshotBytes.length > 0) {
    userBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: Buffer.from(screenshotBytes).toString("base64"),
      },
    });
    userBlocks.push({
      type: "text",
      text:
        "Above is a screenshot of the page at the moment of failure. Use it as visual ground truth when reasoning about what data shape the page expects to render — e.g. if it shows a list with 0 entries, propose entities that would populate it.",
    });
  }
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: REVISE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBlocks }],
  });
  const text = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();

  if (/^CANNOT_EXTEND\b/.test(text)) {
    const reason = text.replace(/^CANNOT_EXTEND[:\s-]*/, "").split("\n")[0].trim() || "Affordance cannot be created via available endpoints.";
    return { cannotExtend: true, reason };
  }

  const json = extractJson(text);
  let parsed: ReviseResult;
  try {
    parsed = JSON.parse(json) as ReviseResult;
  } catch (err) {
    return { cannotExtend: true, reason: `LLM response was not parseable JSON: ${(err as Error).message}` };
  }
  if (!parsed.extensionEntities || !Array.isArray(parsed.extensionEntities) || parsed.extensionEntities.length === 0) {
    // The LLM may have returned a rationale explaining why it declined to extend
    // (e.g. it saw from the screenshot that the page is the wrong one). Surface
    // that reason if present so the report can show why we didn't try.
    const rationale = typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
      ? parsed.rationale.trim()
      : "no rationale provided";
    return { cannotExtend: true, reason: `LLM returned no extension entities. Rationale: ${rationale}` };
  }
  // Validate that names don't collide with existing fixtures.
  for (const e of parsed.extensionEntities) {
    if (!e.name || existingFixtures[e.name]) {
      return { cannotExtend: true, reason: `Extension entity name "${e.name}" collides with an existing fixture.` };
    }
    if (!e.endpoint || !e.body) {
      return { cannotExtend: true, reason: `Extension entity "${e.name}" missing endpoint or body.` };
    }
  }
  return parsed;
}

export interface ApplyResult {
  mergedFixtures: FixtureSummary;
  appliedEntities: FixtureSpecEntity[];
  failedEntityNames: string[];
}

export async function applySeedExtension(args: {
  baseUrl: string;
  existingFixtures: FixtureSummary;
  extensionEntities: FixtureSpecEntity[];
  artifactsDir: string;
  rationale: string;
}): Promise<ApplyResult> {
  const { baseUrl, existingFixtures, extensionEntities, artifactsDir, rationale } = args;
  const synthSpec: FixtureSpec = { rationale, entities: extensionEntities };
  const merged = await executeSpec(baseUrl, synthSpec, existingFixtures);

  // Identify entities whose POST failed (executeSpec records "HTTP <code>" or "error:" in note when it does).
  const failedEntityNames: string[] = [];
  for (const e of extensionEntities) {
    const entry = merged[e.name];
    if (!entry || (entry.note && /^HTTP \d+|^error:/.test(entry.note))) {
      failedEntityNames.push(e.name);
    }
  }

  // Persist: overwrite fixtures.after.json with the merged set, and write the extension manifest as a sidecar.
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, "fixtures.after.json"), JSON.stringify(merged, null, 2));
  await fs.writeFile(
    path.join(artifactsDir, "fixture-spec.extension.json"),
    JSON.stringify(synthSpec, null, 2),
  );

  return { mergedFixtures: merged, appliedEntities: extensionEntities, failedEntityNames };
}

export async function readExistingExtension(artifactsDir: string): Promise<FixtureSpec | null> {
  try {
    const raw = await fs.readFile(path.join(artifactsDir, "fixture-spec.extension.json"), "utf8");
    return JSON.parse(raw) as FixtureSpec;
  } catch {
    return null;
  }
}

function renderFixturesSummary(summary: FixtureSummary): string {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(summary)) {
    if (Object.keys(entry.values).length === 0) continue;
    const fields = Object.entries(entry.values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    const suffix = entry.note ? ` — ${entry.note}` : "";
    lines.push(`- ${name}: ${fields}${suffix}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function extractJson(text: string): string {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const m of fences) {
    const inner = m[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text;
}

function stripNoiseFromHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "<svg/>")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{3,}/g, "  ");
}
