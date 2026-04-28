import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { FixtureSpec } from "../types.ts";
import { AVAILABLE_ENDPOINTS } from "./paperclip-seed.ts";

const MODEL = "claude-opus-4-7";
const MAX_TEST_FILE_CHARS = 80_000;
const MAX_TEST_FILES = 40;

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

async function collectAdjacentTests(diff: string, worktreePath: string): Promise<Array<{ path: string; content: string }>> {
  const changedFiles = parseChangedFiles(diff);
  const candidatePaths = new Set<string>();

  for (const file of changedFiles) {
    if (file.includes(".test.") || file.includes(".spec.")) {
      candidatePaths.add(file);
      continue;
    }
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.(tsx?|jsx?)$/, "");
    for (const suffix of [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"]) {
      candidatePaths.add(path.join(dir, `${base}${suffix}`));
    }
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
    } catch {}
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

  const resp = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    betas: ["context-1m-2025-08-07"],
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
