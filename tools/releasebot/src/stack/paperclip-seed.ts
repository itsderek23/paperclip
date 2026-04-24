import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { FixtureSpec, FixtureSpecEntity, FixtureSummary } from "../types.ts";

const MODEL = "claude-opus-4-7";
const MAX_TEST_FILE_CHARS = 20_000;
const MAX_TEST_FILES = 8;

const AVAILABLE_ENDPOINTS = `
Available write endpoints (local_trusted, no auth required). Use ONLY these — other paths return 404 or require approval flows.

  POST /api/companies
    body: { name: string }
    response: { id: string, ... }
    Capture: id (always).

  POST /api/companies/:companyId/issues
    body: {
      title: string,
      description?: string,
      blockedByIssueIds?: string[],      // array of UUIDs of blocker issues
      parentId?: string,                  // UUID of parent issue (NOT "parentIssueId")
    }
    response: { id: string, identifier: string, ... }
    Capture: id AND identifier. URLs use the identifier: /issues/<identifier>.
    Unknown fields are silently dropped — use EXACTLY these names.

  POST /api/issues/:issueId/comments
    body: { body: string }
    response: { id: string }
    Capture: id.

DO NOT attempt agent creation — it requires a hire/approval flow that can't complete synchronously. Do not use any other endpoints.

Template references: use {{name.field}} to interpolate a captured value into a later entity — e.g. "companyId": "{{company.id}}" (though note companyId is in the URL path for issues, not the body).
`;

const SYSTEM_PROMPT = `You are writing a fixture-seeding spec for a single PR against the Paperclip app.

The goal is to create just enough realistic data so a browser plan can exercise every UI surface the PR touches WITHOUT hitting "not found" / empty-state screens. Use the PR diff and the adjacent test files (which show how the UI is normally populated in unit tests) as hints for what shapes the UI expects.

${AVAILABLE_ENDPOINTS}

Output strict JSON matching:

type FixtureSpec = {
  rationale: string;                // 2-4 sentences tying each entity to a UI surface from the diff
  entities: FixtureSpecEntity[];    // ordered: later entries may reference earlier via {{name.field}}
};
type FixtureSpecEntity = {
  name: string;                     // symbolic key, lowercase snake, unique, e.g. "company", "issue_blocked", "issue_blocker"
  endpoint: string;                 // "POST /api/..." — one of the listed endpoints (interpolated IDs are fine)
  body: Record<string, unknown>;    // request JSON; may contain "{{name.field}}" interpolations
  capture?: Record<string, string>; // map of symbolic field -> JSONPath-lite. Use "$.<key>" to capture top-level response fields. ALWAYS capture "id" for any entity that might be referenced.
};

Rules:
- Create a single "company" entity first; everything else references it via {{company.id}}.
- For issue-related PRs, create at least 2-3 issues, including any special relationships the diff hints at (e.g. a blocker pair for PRs touching blocker UI).
- Always capture "id" for every entity. For issues, also capture "pathId".
- Max 10 entities. Don't invent endpoints or fields not listed above.
- Return ONLY the JSON object. No markdown fences, no commentary.`;

export async function synthesizeFixtureSpecFromPr(args: {
  diff: string;
  worktreePath: string;
  apiKey: string;
  artifactsDir: string;
}): Promise<FixtureSpec> {
  const { diff, worktreePath, apiKey, artifactsDir } = args;
  const testHints = await collectAdjacentTests(diff, worktreePath);
  const spec = await synthesizeFixtureSpec({ diff, testHints, apiKey });
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, "fixture-spec.json"), JSON.stringify(spec, null, 2));
  return spec;
}

export async function executeFixtureSpec(args: {
  baseUrl: string;
  spec: FixtureSpec;
  artifactsDir: string;
  sideLabel: string;
}): Promise<FixtureSummary> {
  const { baseUrl, spec, artifactsDir, sideLabel } = args;
  const summary = await executeSpec(baseUrl, spec);
  await fs.writeFile(path.join(artifactsDir, `fixtures.${sideLabel}.json`), JSON.stringify(summary, null, 2));
  return summary;
}

async function collectAdjacentTests(diff: string, worktreePath: string): Promise<Array<{ path: string; content: string }>> {
  const changedFiles = parseChangedFiles(diff);
  const candidatePaths = new Set<string>();

  for (const file of changedFiles) {
    if (file.includes(".test.") || file.includes(".spec.")) {
      candidatePaths.add(file);
      continue;
    }
    // Look for sibling test file
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.(tsx?|jsx?)$/, "");
    for (const suffix of [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"]) {
      candidatePaths.add(path.join(dir, `${base}${suffix}`));
    }
    // Look under a parallel __tests__ dir
    candidatePaths.add(path.join(dir, "__tests__", `${base}.test.ts`));
    candidatePaths.add(path.join(dir, "__tests__", `${base}.test.tsx`));
  }

  const hints: Array<{ path: string; content: string }> = [];
  for (const rel of candidatePaths) {
    if (hints.length >= MAX_TEST_FILES) break;
    const abs = path.join(worktreePath, rel);
    try {
      const buf = await fs.readFile(abs, "utf8");
      const content = buf.length > MAX_TEST_FILE_CHARS ? buf.slice(0, MAX_TEST_FILE_CHARS) + "\n// ...truncated" : buf;
      hints.push({ path: rel, content });
    } catch {
      // not found — skip
    }
  }
  return hints;
}

function parseChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) files.add(m[1]);
  }
  return [...files];
}

async function synthesizeFixtureSpec(args: {
  diff: string;
  testHints: Array<{ path: string; content: string }>;
  apiKey: string;
}): Promise<FixtureSpec> {
  const { diff, testHints, apiKey } = args;
  const client = new Anthropic({ apiKey });
  const truncatedDiff = diff.length > 120_000 ? diff.slice(0, 120_000) + "\n... (truncated)" : diff;
  const hintsBlock = testHints.length
    ? testHints.map((h) => `--- ${h.path} ---\n${h.content}`).join("\n\n")
    : "(no adjacent test files found)";

  const userContent = [
    "Unified diff:",
    "```diff",
    truncatedDiff,
    "```",
    "",
    `Adjacent test files (${testHints.length}) — use these to infer what fixture shapes the UI expects:`,
    "",
    hintsBlock,
  ].join("\n");

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });
  const text = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  const json = extractJson(text);
  const spec = JSON.parse(json) as FixtureSpec;
  if (!Array.isArray(spec.entities) || spec.entities.length === 0) {
    throw new Error("Fixture spec has no entities");
  }
  return spec;
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text;
}

async function executeSpec(baseUrl: string, spec: FixtureSpec): Promise<FixtureSummary> {
  const summary: FixtureSummary = {};
  for (const entity of spec.entities) {
    try {
      const endpoint = interpolate(entity.endpoint, summary);
      const body = interpolateObject(entity.body, summary);
      const { method, url } = parseEndpoint(endpoint);
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        summary[entity.name] = { values: {}, note: `HTTP ${res.status} from ${method} ${url}: ${(await res.text()).slice(0, 200)}` };
        continue;
      }
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const values = capture(entity, payload);
      // Also carry through a few body fields the planner LLM needs to write
      // exact locators against: title/name. Avoids forcing the seed LLM to
      // remember to capture them, and prevents the planner from hallucinating
      // titles when writing expect(locator).toHaveText(...) / aria-label matches.
      const bodyObj = body as Record<string, unknown>;
      for (const key of ["title", "name"]) {
        if (!(key in values) && typeof bodyObj[key] === "string") {
          values[key] = bodyObj[key] as string;
        }
      }
      // Relationship annotations — the planner needs to know which issue blocks
      // which and which has a parent, so it can pick a URL that actually exercises
      // the feature under test.
      const note = formatRelationships(bodyObj, summary);
      summary[entity.name] = note ? { values, note } : { values };
    } catch (err) {
      summary[entity.name] = { values: {}, note: `error: ${(err as Error).message}` };
    }
  }
  return summary;
}

function parseEndpoint(s: string): { method: string; url: string } {
  const m = s.match(/^([A-Z]+)\s+(.+)$/);
  if (!m) throw new Error(`Bad endpoint: ${s}`);
  return { method: m[1], url: m[2] };
}

function formatRelationships(body: Record<string, unknown>, summary: FixtureSummary): string | undefined {
  const parts: string[] = [];
  const parentId = typeof body.parentId === "string" ? body.parentId : undefined;
  if (parentId) {
    const parent = resolveIdentifier(summary, parentId);
    if (parent) parts.push(`parent=${parent}`);
  }
  const blockedByIds = Array.isArray(body.blockedByIssueIds)
    ? (body.blockedByIssueIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (blockedByIds.length > 0) {
    const idents = blockedByIds.map((id) => resolveIdentifier(summary, id)).filter(Boolean);
    if (idents.length > 0) parts.push(`blockedBy=[${idents.join(",")}]`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function resolveIdentifier(summary: FixtureSummary, id: string): string | undefined {
  for (const entry of Object.values(summary)) {
    if (entry.values.id === id) return entry.values.identifier ?? entry.values.id;
  }
  return undefined;
}

function capture(entity: FixtureSpecEntity, payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const caps = entity.capture ?? { id: "$.id" };
  for (const [key, path] of Object.entries(caps)) {
    const m = path.match(/^\$\.(.+)$/);
    if (!m) continue;
    const field = m[1];
    const val = payload[field];
    if (val != null) out[key] = String(val);
  }
  return out;
}

function interpolateObject(obj: unknown, summary: FixtureSummary): unknown {
  if (obj == null) return obj;
  if (typeof obj === "string") return interpolate(obj, summary);
  if (Array.isArray(obj)) return obj.map((v) => interpolateObject(v, summary));
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = interpolateObject(v, summary);
    return out;
  }
  return obj;
}

function interpolate(s: string, summary: FixtureSummary): string {
  return s.replace(/\{\{([^}]+?)\}\}/g, (_, expr) => {
    const [name, field] = String(expr).trim().split(".");
    return summary[name]?.values[field] ?? "";
  });
}
