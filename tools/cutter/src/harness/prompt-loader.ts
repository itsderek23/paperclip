import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");

export interface PromptContext {
  adapterHints: string;
  perPrContext: string;
}

export async function buildPrompt(stage: "plan" | "review" | "annotate", ctx: PromptContext): Promise<string> {
  const stagePath = path.join(PROMPTS_DIR, `${stage}.md`);
  const raw = await fs.readFile(stagePath, "utf8");
  const withIncludes = await resolveIncludes(raw, PROMPTS_DIR);
  return withIncludes
    .replace(/\{\{ADAPTER_HINTS\}\}/g, ctx.adapterHints.trim() || "(no stack-specific hints provided)")
    .replace(/\{\{PER_PR_CONTEXT\}\}/g, ctx.perPrContext.trim());
}

async function resolveIncludes(text: string, baseDir: string): Promise<string> {
  const directive = /<<INCLUDE\s+([^>]+?)\s*>>/g;
  const out: string[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(directive)) {
    const [whole, relPath] = match;
    out.push(text.slice(lastIndex, match.index));
    const includePath = path.resolve(baseDir, relPath);
    const body = await fs.readFile(includePath, "utf8");
    out.push(body.trim());
    lastIndex = (match.index ?? 0) + whole.length;
  }
  out.push(text.slice(lastIndex));
  return out.join("\n");
}

export interface PerPrContextInput {
  pr: { number: number; title: string; body: string; url: string; baseSha: string; headSha: string };
  diff: string;
  sourceContext?: string;
  fixtureSummary?: Record<string, { values: Record<string, string>; note?: string }>;
}

const MAX_DIFF_CHARS = 180_000;

export function renderPerPrContext(input: PerPrContextInput): string {
  const { pr } = input;
  const lines: string[] = [];
  lines.push(`PR #${pr.number}: ${pr.title}`);
  lines.push(`URL: ${pr.url}`);
  lines.push(`base: ${pr.baseSha.slice(0, 12)} · head: ${pr.headSha.slice(0, 12)}`);
  lines.push("");
  lines.push("Body:");
  lines.push(pr.body || "(empty)");
  lines.push("");

  if (input.fixtureSummary && Object.keys(input.fixtureSummary).length > 0) {
    lines.push("Seeded fixtures available on both sides (use these exact values in step URLs and locators, or via {{name.field}} templates):");
    for (const [name, entry] of Object.entries(input.fixtureSummary)) {
      const fields = Object.entries(entry.values)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      const suffix = entry.note ? ` — ${entry.note}` : "";
      if (fields) lines.push(`- ${name}: ${fields}${suffix}`);
    }
    lines.push("");
  }

  if (input.sourceContext) {
    lines.push("Source context around each diff hunk (post-PR state — use these EXACT aria-label / role-name / data-testid / button-text values in your locators; do NOT guess):");
    lines.push("");
    lines.push(input.sourceContext);
    lines.push("");
  }

  const diff = input.diff.length > MAX_DIFF_CHARS
    ? input.diff.slice(0, MAX_DIFF_CHARS) + "\n\n... (diff truncated)"
    : input.diff;
  lines.push("Unified diff:");
  lines.push("```diff");
  lines.push(diff);
  lines.push("```");

  return lines.join("\n");
}
