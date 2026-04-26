import fs from "node:fs/promises";
import path from "node:path";
import type { Plan, PrMeta, SideResult } from "./types.ts";

const MARKER = "<!-- releasebot:comment-marker v1 -->";

/**
 * Builds the markdown body of the GitHub PR comment releasebot would post.
 *
 * Single source of truth for "what releasebot would say" — the preview HTML
 * and the future comment-poster service both consume this output.
 *
 * Image references are repo-relative paths under `artifactsDir` (e.g.
 * `before/step-01.crop.png`). They resolve naturally when opened via file://
 * from the artifacts dir, and they'll be rewritten to absolute service URLs
 * by the future comment-poster before being POSTed to GitHub.
 *
 * Shape: URL-grouped before/after crop tables. No verdicts, no LLM
 * observations, no Playwright assertion counts, no repair badges — those
 * live in the linked report.html.
 */
export async function buildCommentMarkdown(args: {
  pr: PrMeta;
  plan: Plan;
  before: SideResult;
  after: SideResult;
  artifactsDir: string;
}): Promise<string> {
  const { pr, plan, before, after, artifactsDir } = args;
  const lines: string[] = [];
  lines.push(MARKER);
  lines.push(`### releasebot · PR #${pr.number}`);
  lines.push("");

  if (plan.metadata.steps.length === 0) {
    lines.push("releasebot skipped this PR — see [full report](report.html) for why.");
    lines.push("");
    return lines.join("\n");
  }

  const baseShort = pr.baseSha.slice(0, 7);
  const headShort = pr.headSha.slice(0, 7);

  // Group consecutive steps with the same URL under one "UI changes on" line.
  const groups: Array<{ url: string; stepIndices: number[] }> = [];
  for (let i = 0; i < plan.metadata.steps.length; i++) {
    const url = plan.metadata.steps[i].url;
    const last = groups[groups.length - 1];
    if (last && last.url === url) last.stepIndices.push(i);
    else groups.push({ url, stepIndices: [i] });
  }

  for (const group of groups) {
    lines.push(`UI changes on \`${group.url}\`:`);
    lines.push("");
    for (const i of group.stepIndices) {
      const step = plan.metadata.steps[i];
      const beforeCell = await buildImageCell({
        side: "before",
        stepIndex: i,
        sideResult: before,
        artifactsDir,
      });
      const afterCell = await buildImageCell({
        side: "after",
        stepIndex: i,
        sideResult: after,
        artifactsDir,
      });
      lines.push(`**${step.description}**`);
      lines.push("");
      lines.push(`| before · \`${baseShort}\` | after · \`${headShort}\` |`);
      lines.push(`|---|---|`);
      lines.push(`| ${beforeCell} | ${afterCell} |`);
      lines.push("");
    }
  }

  lines.push(`[Full report ↗](report.html)`);
  lines.push("");
  return lines.join("\n");
}

async function buildImageCell(args: {
  side: "before" | "after";
  stepIndex: number;
  sideResult: SideResult;
  artifactsDir: string;
}): Promise<string> {
  const { side, stepIndex, sideResult, artifactsDir } = args;
  const stepResult = sideResult.steps[stepIndex];
  if (!stepResult) return `_screenshot unavailable_`;

  const fullRel = path.relative(artifactsDir, stepResult.screenshot);
  const cropAbs = stepResult.screenshot.replace(/\.png$/, ".crop.png");
  const cropExists = await fileExists(cropAbs);
  const thumbRel = cropExists ? path.relative(artifactsDir, cropAbs) : fullRel;

  return `<a href="${fullRel}" target="_blank" rel="noopener"><img src="${thumbRel}" alt="${side}"></a>`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
