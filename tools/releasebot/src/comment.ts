import fs from "node:fs/promises";
import path from "node:path";
import type { Plan, PrMeta, RunReview, SideResult } from "./types.ts";

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
  review: RunReview;
  artifactsDir: string;
}): Promise<string> {
  const { pr, plan, before, after, review, artifactsDir } = args;
  const lines: string[] = [];
  lines.push(MARKER);
  lines.push(`### Cutter Summary`);
  lines.push("");

  const inconclusiveIndices = plan.metadata.steps
    .map((_, i) => i)
    .filter((i) => review.steps.find((s) => s.step_n === i + 1)?.verdict === "inconclusive");
  if (inconclusiveIndices.length > 0) {
    for (const i of inconclusiveIndices) {
      const reason =
        after.steps[i]?.repair?.reason?.trim() ||
        after.steps[i]?.error?.trim() ||
        "the test could not reach the planned surface";
      lines.push(`> ⚠ **Couldn't verify this change** — ${reason}`);
      lines.push("");
    }
    lines.push(`[Full report ↗](report.html)`);
    lines.push("");
    return lines.join("\n");
  }

  const coverageNote = plan.metadata.coverageNote?.trim();
  if (coverageNote) {
    lines.push(`> ⚠ **Coverage limit** — ${coverageNote}`);
    lines.push("");
  } else {
    const narrative = extractNarrativeSummary(review.summary);
    if (narrative) {
      lines.push(narrative);
      lines.push("");
    }
  }

  if (plan.metadata.steps.length === 0) {
    lines.push("cutter skipped this PR — see [full report](report.html) for why.");
    lines.push("");
    return lines.join("\n");
  }

  const baseShort = pr.baseSha.slice(0, 7);
  const headShort = pr.headSha.slice(0, 7);

  const groupKey = (i: number): string => {
    const rv = review.steps.find((s) => s.step_n === i + 1);
    const kind = rv?.pageKind?.trim();
    return kind && kind.length > 0 ? `kind:${kind}` : `url:${plan.metadata.steps[i].url}`;
  };

  const groups: Array<{ key: string; pageKind?: string; url: string; stepIndices: number[] }> = [];
  for (let i = 0; i < plan.metadata.steps.length; i++) {
    const key = groupKey(i);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.stepIndices.push(i);
    else {
      const rv = review.steps.find((s) => s.step_n === i + 1);
      groups.push({
        key,
        pageKind: rv?.pageKind?.trim() || undefined,
        url: plan.metadata.steps[i].url,
        stepIndices: [i],
      });
    }
  }

  for (const group of groups) {
    if (group.pageKind) {
      lines.push(`**${group.pageKind}**`);
    } else {
      lines.push(`UI changes on \`${group.url}\`:`);
    }
    lines.push("");
    for (const i of group.stepIndices) {
      const verdict = review.steps.find((s) => s.step_n === i + 1)?.verdict;
      if (verdict === "pass") {
        const cell = await buildImageCell({
          side: "after",
          stepIndex: i,
          sideResult: after,
          artifactsDir,
        });
        lines.push(`*No visible differences before/after.*`);
        lines.push("");
        lines.push(cell);
        lines.push("");
        continue;
      }
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
  const annotatedAbs = stepResult.screenshot.replace(/\.png$/, ".annotated.png");
  if (side === "after" && (await fileExists(annotatedAbs))) {
    const annotatedRel = path.relative(artifactsDir, annotatedAbs);
    return `<a href="${annotatedRel}" target="_blank" rel="noopener"><img src="${annotatedRel}" alt="${side}"></a>`;
  }
  const cropAbs = stepResult.screenshot.replace(/\.png$/, ".crop.png");
  const cropExists = await fileExists(cropAbs);
  const thumbRel = cropExists ? path.relative(artifactsDir, cropAbs) : fullRel;

  return `<a href="${fullRel}" target="_blank" rel="noopener"><img src="${thumbRel}" alt="${side}"></a>`;
}

function extractNarrativeSummary(summary: string): string {
  const m = summary.match(/passed before, \d+\/\d+ passed after\.\s*/);
  const tail = m ? summary.slice(m.index! + m[0].length) : summary;
  return tail.trim();
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
