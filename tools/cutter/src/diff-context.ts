import fs from "node:fs/promises";
import path from "node:path";

const CONTEXT_LINES_BEFORE = 12;
const CONTEXT_LINES_AFTER = 24;
const MAX_HUNKS = 60;
const MAX_TOTAL_CHARS = 150_000;

/**
 * Parse the unified diff and extract source context around each hunk — read from
 * the *after* worktree so the LLM sees the post-PR state (literal `aria-label`
 * values, `data-testid`s, new component names, etc.) rather than guessing.
 *
 * Only includes files that look UI-relevant (ui/ paths, .tsx/.ts/.jsx). Caps
 * total output size so we don't blow the plan prompt budget.
 */
export async function gatherDiffContext(diff: string, afterWorktreePath: string): Promise<string> {
  const hunks = parseHunks(diff);
  const uiHunks = hunks.filter(isUiRelevant).slice(0, MAX_HUNKS);
  const blocks: string[] = [];
  let totalChars = 0;

  for (const hunk of uiHunks) {
    const abs = path.join(afterWorktreePath, hunk.file);
    let contents: string;
    try {
      contents = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const lines = contents.split("\n");
    const start = Math.max(1, hunk.newStart - CONTEXT_LINES_BEFORE);
    const end = Math.min(lines.length, hunk.newStart + hunk.newLines + CONTEXT_LINES_AFTER);
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, i) => `${String(start + i).padStart(4, " ")}  ${line}`).join("\n");
    const block = `--- ${hunk.file} (around line ${hunk.newStart}, showing ${start}-${end}) ---\n${numbered}`;
    if (totalChars + block.length > MAX_TOTAL_CHARS) break;
    blocks.push(block);
    totalChars += block.length;
  }

  if (blocks.length === 0) return "";
  return blocks.join("\n\n");
}

interface Hunk {
  file: string;
  newStart: number;
  newLines: number;
}

function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  const lines = diff.split("\n");
  let currentFile: string | null = null;
  for (const line of lines) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      out.push({
        file: currentFile,
        newStart: Number(hunkMatch[1]),
        newLines: Number(hunkMatch[2] ?? "1"),
      });
    }
  }
  return out;
}

function isUiRelevant(hunk: Hunk): boolean {
  const f = hunk.file;
  // Exclude test files — they're already supplied separately to the fixture synthesizer;
  // for the plan we want actual component source, not mock setups.
  if (/\.(test|spec|stories)\.(t|j)sx?$/.test(f)) return false;
  if (f.startsWith("ui/")) return true;
  // Some apps keep components under packages/ — include .tsx/.jsx/.svelte anywhere.
  if (/\.(tsx|jsx|svelte)$/.test(f)) return true;
  return false;
}
