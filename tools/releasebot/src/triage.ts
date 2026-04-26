import Anthropic from "@anthropic-ai/sdk";
import type { FixtureSummary, TriageAction } from "./types.ts";

const MODEL = "claude-opus-4-7";

const TRIAGE_SYSTEM_PROMPT = `You are diagnosing a single Playwright test failure on the AFTER side of a PR-QA run and choosing exactly one repair action.

Inputs you receive in the user message:
  - The step description (the QA goal for this test).
  - The URL the test goto'd.
  - The original test body that failed.
  - The Playwright failure message.
  - The captured seed fixtures (entities the harness POSTed for this run; identifiers/IDs/titles).
  - The PR diff (truncated).
  - The rendered HTML at moment of failure (script/style/svg stripped).
  - A screenshot of the page at moment of failure.

Your job: pick exactly ONE action and emit JSON matching the schema below. No prose, no fences, no commentary outside the JSON.

Available actions:

  "rewrite_locator"
    Use when: the affordance the diff added IS rendered (DOM and screenshot show it), but the locator path the test used is wrong (different role, scoping, attribute). The downstream executor will re-write the locator from the DOM.

  "rewrite_url"
    Use when: the page is the wrong page. Common causes — the goto URL contains an identifier that doesn't appear in the captured fixtures (hallucinated by the planner), or the URL points to a different entity than the seed actually has, or the page rendered a 404 / "not found" / generic error. You MUST emit a "suggestedUrl" string built from a fixture identifier you can name. If you cannot construct a defensible replacement URL from the fixtures, do NOT pick this action — pick "give_up" instead.

  "extend_seed"
    Use when: the page rendered IS the page the test wanted, but the affordance the diff added requires a data shape that the captured fixtures don't cover (no overdue tasks, no parent-with-children, no blocked issues, etc.). DOM and screenshot must both agree the page is correct. The downstream executor will synthesize and POST new fixture entities.

  "give_up"
    Use when: evidence is contradictory; the failure looks like a real regression in the diff; the affordance can't be created via the available endpoints; or none of the above actions has enough confidence.

Decision priorities:
  1. Prefer the rendered DOM and screenshot over the seed summary if they disagree — fixtures show what we tried to seed, the page shows what's actually on screen.
  2. The captured fixtures list entities seeded for THIS PR run only; the database may contain additional entities from prior runs not visible in the summary. Treat the summary as "this run's intent", not as a complete DB census.
  3. If the test's URL contains a value (UUID, identifier, slug) that doesn't appear in the captured fixtures AND no obvious DB-of-record can vouch for it, the URL was probably hallucinated → "rewrite_url" with a fixture-grounded replacement.
  4. Only pick "extend_seed" when the page is clearly the right one (heading, layout, route match what the test wanted) but the affordance is genuinely missing.
  5. When in real doubt, pick "give_up" with a one-sentence reason. A wrong action that "succeeds" silently is worse than an honest decline.

Output schema (strict JSON):
{
  "action": "rewrite_locator" | "rewrite_url" | "extend_seed" | "give_up",
  "reason": string,                           // 1-2 sentences citing the evidence (URL contains UUID X not in fixtures, screenshot shows 'Not Found' header, etc.)
  "suggestedUrl"?: string                     // REQUIRED when action === "rewrite_url"; otherwise omit
}`;

export async function triageStepFailure(args: {
  apiKey: string;
  stepDescription: string;
  failedStepUrl: string;
  originalTestBody: string;
  failureSummary: string;
  domHtml: string;
  fixtures: FixtureSummary;
  diff: string;
  screenshotBytes?: Uint8Array;
}): Promise<TriageAction> {
  const {
    apiKey,
    stepDescription,
    failedStepUrl,
    originalTestBody,
    failureSummary,
    domHtml,
    fixtures,
    diff,
    screenshotBytes,
  } = args;
  const client = new Anthropic({ apiKey });

  const trimmedHtml = stripNoiseFromHtml(domHtml).slice(0, 120_000);
  const truncatedDiff = diff.length > 60_000 ? diff.slice(0, 60_000) + "\n... (truncated)" : diff;
  const fixturesBlock = renderFixtures(fixtures);

  const userText = [
    `Step description: ${stepDescription}`,
    `Test goto'd URL: ${failedStepUrl}`,
    "",
    "Original test body that failed:",
    "```ts",
    originalTestBody.trim(),
    "```",
    "",
    "Failure message:",
    failureSummary,
    "",
    "Captured seed fixtures (this PR's seed run; DB may contain more from prior runs):",
    fixturesBlock,
    "",
    "PR diff (truncated):",
    "```diff",
    truncatedDiff,
    "```",
    "",
    "Rendered HTML at moment of failure (script/style/svg stripped):",
    "```html",
    trimmedHtml,
    "```",
  ].join("\n");

  const userBlocks: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: userText }];
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
      text: "Above is the screenshot at moment of failure. Use it as ground truth for which page rendered.",
    });
  }

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: TRIAGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userBlocks }],
  });
  const text = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();

  const json = extractJson(text);
  let parsed: { action?: string; reason?: string; suggestedUrl?: string };
  try {
    parsed = JSON.parse(json) as { action?: string; reason?: string; suggestedUrl?: string };
  } catch {
    return { kind: "give_up", reason: `Triage LLM response was not parseable JSON: ${text.slice(0, 200)}` };
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : "(no reason provided)";

  switch (parsed.action) {
    case "rewrite_locator":
      return { kind: "rewrite_locator", reason };
    case "rewrite_url": {
      const suggestedUrl = typeof parsed.suggestedUrl === "string" ? parsed.suggestedUrl.trim() : "";
      if (!suggestedUrl.startsWith("/")) {
        return {
          kind: "give_up",
          reason: `Triage chose rewrite_url but suggestedUrl is missing or not a relative path: "${suggestedUrl}". Original reason: ${reason}`,
        };
      }
      return { kind: "rewrite_url", reason, suggestedUrl };
    }
    case "extend_seed":
      return { kind: "extend_seed", reason };
    case "give_up":
      return { kind: "give_up", reason };
    default:
      return {
        kind: "give_up",
        reason: `Triage LLM returned unrecognized action "${parsed.action}". Raw reason: ${reason}`,
      };
  }
}

function renderFixtures(summary: FixtureSummary): string {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(summary)) {
    if (Object.keys(entry.values).length === 0) {
      if (entry.note) lines.push(`- ${name}: (no values captured) — ${entry.note}`);
      continue;
    }
    const fields = Object.entries(entry.values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    const suffix = entry.note ? ` — ${entry.note}` : "";
    lines.push(`- ${name}: ${fields}${suffix}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no fixtures captured)";
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
