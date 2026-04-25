import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BBox, Plan, PrMeta, RunReview, SideResult } from "./types.ts";

const CROP_PAD = 40;
const MIN_CROP_W = 200;
const MIN_CROP_H = 120;
const HUGE_CROP_THRESHOLD = 0.8;

interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface StepCrop {
  beforeCropRel: string;
  afterCropRel: string;
}

export async function writeReport(args: {
  pr: PrMeta;
  plan: Plan;
  before: SideResult;
  after: SideResult;
  review: RunReview;
  artifactsDir: string;
}): Promise<{ markdownPath: string; htmlPath: string }> {
  const { pr, plan, before, after, review, artifactsDir } = args;
  const markdownPath = path.join(artifactsDir, "report.md");
  const htmlPath = path.join(artifactsDir, "report.html");

  await fs.writeFile(markdownPath, renderMarkdown({ pr, plan, before, after, review }));
  await fs.writeFile(htmlPath, await renderHtml({ pr, plan, before, after, review, artifactsDir }));

  return { markdownPath, htmlPath };
}

function renderMarkdown(args: {
  pr: PrMeta;
  plan: Plan;
  before: SideResult;
  after: SideResult;
  review: RunReview;
}): string {
  const { pr, plan, before, after, review } = args;
  const lines: string[] = [];
  lines.push(`# releasebot — PR #${pr.number}`);
  lines.push("");
  lines.push(`**${pr.title}**  `);
  lines.push(`${pr.url}  `);
  lines.push(`base: \`${pr.baseSha.slice(0, 7)}\` · head: \`${pr.headSha.slice(0, 7)}\`  `);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(review.summary);
  lines.push("");
  lines.push(`## Plan`);
  lines.push("");
  lines.push(`**Title:** ${plan.metadata.title}  `);
  lines.push(`**Goal:** ${plan.metadata.goal}  `);
  lines.push("");
  lines.push(`**Rationale:** ${plan.metadata.rationale}`);
  lines.push("");
  lines.push(`## Steps`);
  lines.push("");
  lines.push(`| # | Step | URL | Assertion | Before | After | Verdict | Observation |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const [i, step] of plan.metadata.steps.entries()) {
    const b = before.steps[i];
    const a = after.steps[i];
    const rv = review.steps.find((s) => s.step_n === i + 1);
    const beforeImg = b ? `![](${path.relative(path.dirname(""), b.screenshot)})` : "—";
    const afterImg = a ? `![](${path.relative(path.dirname(""), a.screenshot)})` : "—";
    // Playwright assertion layer is a safety-net signal; visual review is source of truth.
    // Before-side assert fails are expected (diff copy not yet present); don't mark them red.
    const assertCell = a?.status === "fail" ? "⚠" : "✓";
    const verdictCell = rv ? verdictBadge(rv.verdict) : "—";
    const obs = rv?.observation ?? "";
    lines.push(`| ${i + 1} | ${escapeCell(step.description)} | \`${step.url}\` | ${assertCell} | ${beforeImg} | ${afterImg} | ${verdictCell} | ${escapeCell(obs)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function verdictBadge(v: string): string {
  if (v === "pass") return "✓ pass";
  if (v === "intentional_change") return "◆ intentional";
  return "✗ fail";
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function renderHtml(args: {
  pr: PrMeta;
  plan: Plan;
  before: SideResult;
  after: SideResult;
  review: RunReview;
  artifactsDir: string;
}): Promise<string> {
  const { pr, plan, before, after, review, artifactsDir } = args;
  const rows: string[] = [];
  const traceBefore = path.relative(artifactsDir, path.join(artifactsDir, "generated/before/test-output"));
  const traceAfter = path.relative(artifactsDir, path.join(artifactsDir, "generated/after/test-output"));
  const specBefore = path.relative(artifactsDir, path.join(artifactsDir, "generated/before/generated.spec.ts"));
  const specAfter = path.relative(artifactsDir, path.join(artifactsDir, "generated/after/generated.spec.ts"));
  for (const [i, step] of plan.metadata.steps.entries()) {
    const b = before.steps[i];
    const a = after.steps[i];
    const rv = review.steps.find((s) => s.step_n === i + 1);
    const beforeSrc = b ? path.relative(artifactsDir, b.screenshot) : "";
    const afterSrc = a ? path.relative(artifactsDir, a.screenshot) : "";
    const verdict = rv?.verdict ?? "pass";
    const obs = rv?.observation ?? "";
    const crop = (b && a) ? await maybeBuildCrop(b.screenshot, a.screenshot, b.bboxes, a.bboxes, artifactsDir) : null;

    const fullPair = `
  <div class="pair">
    <figure><figcaption>before · ${pr.baseSha.slice(0, 7)}</figcaption>${beforeSrc ? `<a href="${escapeAttr(beforeSrc)}" target="_blank" rel="noopener"><img src="${escapeAttr(beforeSrc)}" /></a>` : `<div class="missing">missing</div>`}</figure>
    <figure><figcaption>after · ${pr.headSha.slice(0, 7)}</figcaption>${afterSrc ? `<a href="${escapeAttr(afterSrc)}" target="_blank" rel="noopener"><img src="${escapeAttr(afterSrc)}" /></a>` : `<div class="missing">missing</div>`}</figure>
  </div>`;

    const focusBlock = crop
      ? `
  <div class="focus">
    <p class="focus-label">Change focus</p>
    <div class="pair pair-crop">
      <figure><figcaption>before · ${pr.baseSha.slice(0, 7)}</figcaption><a href="${escapeAttr(crop.beforeCropRel)}" target="_blank" rel="noopener"><img src="${escapeAttr(crop.beforeCropRel)}" /></a></figure>
      <figure><figcaption>after · ${pr.headSha.slice(0, 7)}</figcaption><a href="${escapeAttr(crop.afterCropRel)}" target="_blank" rel="noopener"><img src="${escapeAttr(crop.afterCropRel)}" /></a></figure>
    </div>
  </div>
  <details class="full-toggle"><summary>Show full screenshot</summary>${fullPair}</details>`
      : fullPair;

    rows.push(`
<section class="step verdict-${verdict}">
  <header>
    <span class="n">${i + 1}</span>
    <h3>${escapeHtml(step.description)}</h3>
    <span class="verdict">${escapeHtml(verdictLabel(verdict))}</span>
  </header>
  <p class="meta"><code>${escapeHtml(step.url)}</code></p>
  ${obs ? `<p class="obs">${escapeHtml(obs)}</p>` : ""}
  ${focusBlock}
</section>`);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>releasebot · PR #${pr.number}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1400px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin: 0 0 .25rem; }
  .pr-url { color: #555; }
  .summary { background: #f5f5f7; padding: 1rem 1.25rem; border-radius: 8px; margin: 1rem 0 2rem; }
  .rationale { color: #333; }
  .step { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.25rem; margin: 0 0 1.25rem; }
  .step header { display: flex; align-items: center; gap: .75rem; }
  .step .n { display: inline-block; min-width: 1.75rem; padding: 0 .4rem; background: #eee; border-radius: 4px; text-align: center; font-weight: 600; }
  .step h3 { margin: 0; flex: 1; font-size: 1rem; }
  .step .verdict { font-weight: 600; font-size: .85rem; padding: .15rem .5rem; border-radius: 4px; }
  .verdict-pass .verdict { background: #dff3df; color: #2a6d2a; }
  .verdict-intentional_change .verdict { background: #e3ecfa; color: #1f4a94; }
  .verdict-fail .verdict { background: #fadede; color: #962727; }
  .meta { color: #666; font-size: .85rem; margin: .25rem 0 .5rem; }
  .obs { margin: .5rem 0 .75rem; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  .pair-crop figure img { max-height: 360px; width: auto; max-width: 100%; margin: 0 auto; }
  .pair-crop figure { display: flex; flex-direction: column; align-items: stretch; }
  .pair-crop figure a { display: flex; justify-content: center; align-items: center; padding: .5rem; background: #fafafa; }
  .focus { margin: 0 0 .75rem; }
  .focus-label { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: #555; margin: 0 0 .4rem; font-weight: 600; }
  details.full-toggle { margin-top: .75rem; }
  details.full-toggle > summary { cursor: pointer; font-size: .8rem; color: #555; padding: .35rem .5rem; border: 1px dashed #ccc; border-radius: 4px; display: inline-block; user-select: none; }
  details.full-toggle[open] > summary { margin-bottom: .5rem; }
  figure { margin: 0; border: 1px solid #eee; border-radius: 6px; overflow: hidden; background: #fafafa; }
  figcaption { padding: .4rem .6rem; font-size: .75rem; color: #555; background: #f0f0f0; border-bottom: 1px solid #eee; }
  figure a { display: block; text-decoration: none; }
  figure img { display: block; width: 100%; height: auto; }
  figure a:hover img { opacity: .92; }
  .missing { padding: 3rem; text-align: center; color: #999; }
  code { background: #f1f1f3; padding: 0 .3rem; border-radius: 3px; font-size: .85em; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #e4e4e7; }
    .summary { background: #1d1d20; }
    .step { border-color: #333; }
    figure { background: #1a1a1d; border-color: #333; }
    figcaption { background: #222; border-color: #333; color: #bbb; }
    code { background: #26262a; }
    .focus-label { color: #aaa; }
    details.full-toggle > summary { color: #aaa; border-color: #444; }
    .pair-crop figure a { background: #1a1a1d; }
  }
</style>
</head><body>
<h1>PR #${pr.number}: ${escapeHtml(pr.title)}</h1>
<p class="pr-url"><a href="${escapeAttr(pr.url)}">${escapeAttr(pr.url)}</a>
 · base <code>${pr.baseSha.slice(0, 7)}</code> · head <code>${pr.headSha.slice(0, 7)}</code></p>
<div class="summary">
  <p><strong>${escapeHtml(plan.metadata.title)}</strong> — ${escapeHtml(plan.metadata.goal)}</p>
  <p>${escapeHtml(review.summary)}</p>
  <p class="rationale"><em>Plan rationale:</em> ${escapeHtml(plan.metadata.rationale)}</p>
  <p class="artifacts-links">
    <a href="${escapeAttr(specBefore)}">before spec</a> ·
    <a href="${escapeAttr(specAfter)}">after spec</a> ·
    <a href="${escapeAttr(traceBefore)}">before trace output</a> ·
    <a href="${escapeAttr(traceAfter)}">after trace output</a>
  </p>
</div>
${rows.join("\n")}
</body></html>`;
}

function verdictLabel(v: string): string {
  if (v === "pass") return "✓ pass";
  if (v === "intentional_change") return "◆ intentional change";
  return "✗ fail";
}

function unionRect(boxes: BBox[]): BBox {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const b of boxes) {
    if (b.x < x) x = b.x;
    if (b.y < y) y = b.y;
    if (b.x + b.width > right) right = b.x + b.width;
    if (b.y + b.height > bottom) bottom = b.y + b.height;
  }
  return { x, y, width: right - x, height: bottom - y };
}

function expandToMin(rect: CropRect, imgW: number, imgH: number): CropRect {
  let { left, top, width, height } = rect;
  if (width < MIN_CROP_W) {
    const need = MIN_CROP_W - width;
    const grow = Math.min(left, Math.floor(need / 2));
    left -= grow;
    width += grow;
    width = Math.min(MIN_CROP_W, width + Math.min(imgW - (left + width), need - grow));
  }
  if (height < MIN_CROP_H) {
    const need = MIN_CROP_H - height;
    const grow = Math.min(top, Math.floor(need / 2));
    top -= grow;
    height += grow;
    height = Math.min(MIN_CROP_H, height + Math.min(imgH - (top + height), need - grow));
  }
  // Final clamp.
  left = Math.max(0, left);
  top = Math.max(0, top);
  width = Math.min(width, imgW - left);
  height = Math.min(height, imgH - top);
  return { left, top, width, height };
}

async function maybeBuildCrop(
  beforePath: string,
  afterPath: string,
  beforeBboxes: BBox[] | undefined,
  afterBboxes: BBox[] | undefined,
  artifactsDir: string,
): Promise<StepCrop | null> {
  const candidates: BBox[] = [];
  if (beforeBboxes && beforeBboxes.length) candidates.push(...beforeBboxes);
  if (afterBboxes && afterBboxes.length) candidates.push(...afterBboxes);
  if (candidates.length === 0) return null;

  let imgW: number, imgH: number;
  try {
    const meta = await sharp(afterPath).metadata();
    imgW = meta.width ?? 0;
    imgH = meta.height ?? 0;
    if (!imgW || !imgH) return null;
  } catch {
    return null;
  }

  const u = unionRect(candidates);
  if (u.width >= imgW * HUGE_CROP_THRESHOLD && u.height >= imgH * HUGE_CROP_THRESHOLD) return null;

  const padded: CropRect = {
    left: Math.max(0, Math.round(u.x - CROP_PAD)),
    top: Math.max(0, Math.round(u.y - CROP_PAD)),
    width: 0,
    height: 0,
  };
  const right = Math.min(imgW, Math.round(u.x + u.width + CROP_PAD));
  const bottom = Math.min(imgH, Math.round(u.y + u.height + CROP_PAD));
  padded.width = Math.max(1, right - padded.left);
  padded.height = Math.max(1, bottom - padded.top);

  const rect = expandToMin(padded, imgW, imgH);
  if (rect.width < 2 || rect.height < 2) return null;

  const beforeOut = beforePath.replace(/\.png$/, ".crop.png");
  const afterOut = afterPath.replace(/\.png$/, ".crop.png");

  try {
    await Promise.all([
      sharp(beforePath).extract(rect).toFile(beforeOut),
      sharp(afterPath).extract(rect).toFile(afterOut),
    ]);
  } catch {
    return null;
  }

  return {
    beforeCropRel: path.relative(artifactsDir, beforeOut),
    afterCropRel: path.relative(artifactsDir, afterOut),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
