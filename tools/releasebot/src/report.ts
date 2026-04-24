import fs from "node:fs/promises";
import path from "node:path";
import type { Plan, PrMeta, RunReview, SideResult } from "./types.ts";

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
    rows.push(`
<section class="step verdict-${verdict}">
  <header>
    <span class="n">${i + 1}</span>
    <h3>${escapeHtml(step.description)}</h3>
    <span class="verdict">${escapeHtml(verdictLabel(verdict))}</span>
  </header>
  <p class="meta"><code>${escapeHtml(step.url)}</code></p>
  ${obs ? `<p class="obs">${escapeHtml(obs)}</p>` : ""}
  <div class="pair">
    <figure><figcaption>before · ${pr.baseSha.slice(0, 7)}</figcaption>${beforeSrc ? `<a href="${escapeAttr(beforeSrc)}" target="_blank" rel="noopener"><img src="${escapeAttr(beforeSrc)}" /></a>` : `<div class="missing">missing</div>`}</figure>
    <figure><figcaption>after · ${pr.headSha.slice(0, 7)}</figcaption>${afterSrc ? `<a href="${escapeAttr(afterSrc)}" target="_blank" rel="noopener"><img src="${escapeAttr(afterSrc)}" /></a>` : `<div class="missing">missing</div>`}</figure>
  </div>
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
