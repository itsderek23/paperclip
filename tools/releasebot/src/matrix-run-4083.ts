#!/usr/bin/env tsx
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { PaperclipAdapter } from "./stack/paperclip.ts";
import { executeSpec } from "./stack/paperclip-seed.ts";
import { openInstanceDb } from "./stack/db.ts";
import { runVision, type AnnotatorContext } from "./annotators.ts";
import { renderPinCardOverlay } from "./annotate-render.ts";
import { buildCommentPreviewHtml } from "./comment-preview.ts";
import type { FixtureSpec, Plan, PrMeta, RunReview } from "./types.ts";

const log = (m: string) => console.error(`[matrix] ${m}`);

const PR = 4083;
const STEP_PATH = "/issues/LIV-1";
const ACTIVITY_TAB_NAME = /activity/i;
const RENDER_SETTLE_MS = 800;

type Theme = "light" | "dark";
type Device = "desktop" | "mobile";

interface Variant {
  theme: Theme;
  device: Device;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

const VARIANTS: Variant[] = [
  { theme: "light", device: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { theme: "dark", device: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { theme: "light", device: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { theme: "dark", device: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function captureVariant(
  browser: Browser,
  baseUrl: string,
  variant: Variant,
  outPath: string,
): Promise<void> {
  const ctx: BrowserContext = await browser.newContext({
    baseURL: baseUrl,
    viewport: variant.viewport,
    deviceScaleFactor: variant.deviceScaleFactor,
    isMobile: variant.device === "mobile",
    hasTouch: variant.device === "mobile",
    userAgent:
      variant.device === "mobile"
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        : undefined,
  });
  await ctx.addInitScript((theme: string) => {
    try {
      window.localStorage.setItem("paperclip.theme", theme);
    } catch {
      // ignore
    }
  }, variant.theme);
  const page = await ctx.newPage();
  await page.goto(STEP_PATH, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: ACTIVITY_TAB_NAME }).click({ timeout: 10_000 });
  await page.waitForTimeout(RENDER_SETTLE_MS);
  await page.screenshot({ path: outPath, fullPage: false });
  await ctx.close();
}

function variantKey(v: Variant): string {
  return `${v.device}-${v.theme}`;
}

interface RawCapture {
  side: "before" | "after";
  variant: Variant;
  file: string;
}

async function capturePhase(
  matrixDir: string,
  beforeBaseUrl: string,
  afterBaseUrl: string,
): Promise<RawCapture[]> {
  const captures: RawCapture[] = [];
  const allExist = (
    await Promise.all(
      ["before", "after"].flatMap((side) =>
        VARIANTS.map((v) =>
          fileExists(path.join(matrixDir, `${side}-${variantKey(v)}.png`)),
        ),
      ),
    )
  ).every(Boolean);
  if (allExist) {
    log("all 8 raw screenshots already present — skipping capture phase");
    for (const side of ["before", "after"] as const) {
      for (const v of VARIANTS) captures.push({ side, variant: v, file: `${side}-${variantKey(v)}.png` });
    }
    return captures;
  }
  const browser = await chromium.launch();
  try {
    log("capturing matrix (4 variants × 2 sides = 8 screenshots)...");
    for (const side of ["before", "after"] as const) {
      const baseUrl = side === "before" ? beforeBaseUrl : afterBaseUrl;
      for (const variant of VARIANTS) {
        const file = `${side}-${variantKey(variant)}.png`;
        const outPath = path.join(matrixDir, file);
        log(`  ${side} · ${variantKey(variant)}`);
        await captureVariant(browser, baseUrl, variant, outPath);
        captures.push({ side, variant, file });
      }
    }
  } finally {
    await browser.close();
  }
  return captures;
}

async function annotatePhase(
  matrixDir: string,
  artifactsDir: string,
  apiKey: string,
): Promise<void> {
  const plan = JSON.parse(
    await fs.readFile(path.join(artifactsDir, "plan.json"), "utf8"),
  ) as Plan;
  const review = JSON.parse(
    await fs.readFile(path.join(artifactsDir, "review.json"), "utf8"),
  ) as RunReview;
  const pr = JSON.parse(await fs.readFile(path.join(artifactsDir, "pr.json"), "utf8")) as { title: string };

  const planStep = plan.metadata.steps[0];
  const observation = review.steps.find((s) => s.step_n === 1)?.observation ?? "";

  log("annotating each after-side variant (4 vision calls)...");
  for (const variant of VARIANTS) {
    const vk = variantKey(variant);
    const beforePng = path.join(matrixDir, `before-${vk}.png`);
    const afterPng = path.join(matrixDir, `after-${vk}.png`);
    const annotatedFullPng = path.join(matrixDir, `after-${vk}.annotated.full.png`);
    const annotationJson = path.join(matrixDir, `after-${vk}.annotation.json`);

    if (!(await fileExists(afterPng)) || !(await fileExists(beforePng))) {
      log(`  ${vk}: missing raw screenshots — skipping`);
      continue;
    }

    const meta = await sharp(afterPng).metadata();
    const W = meta.width ?? variant.viewport.width;
    const H = meta.height ?? variant.viewport.height;

    const ctx: AnnotatorContext = {
      rawPngPath: afterPng,
      htmlPath: undefined,
      plannerBboxes: [],
      stepDescription: planStep?.description ?? "Activity tab renders run ledger",
      planRationale: plan.metadata.rationale,
      reviewObservation: observation,
      prTitle: pr.title,
      imageWidth: W,
      imageHeight: H,
    };

    let regions;
    if (await fileExists(annotationJson)) {
      const cached = JSON.parse(await fs.readFile(annotationJson, "utf8"));
      regions = cached.regions;
      log(`  ${vk}: using cached annotation (${regions.length} regions)`);
    } else {
      log(`  ${vk}: prompting vision annotator (${W}x${H})...`);
      const result = await runVision(ctx, beforePng, { apiKey });
      if (result.errorMessage) log(`    vision error: ${result.errorMessage}`);
      regions = result.regions;
      await fs.writeFile(
        annotationJson,
        JSON.stringify({ regions, promptedAt: new Date().toISOString() }, null, 2),
      );
    }
    await renderPinCardOverlay(afterPng, regions, annotatedFullPng, W, H);
    log(`  ${vk}: wrote ${regions.length} region(s) overlay`);
  }
}

async function commentPhase(matrixDir: string, artifactsDir: string): Promise<void> {
  const pr = JSON.parse(
    await fs.readFile(path.join(artifactsDir, "pr.json"), "utf8"),
  ) as PrMeta;
  const review = JSON.parse(
    await fs.readFile(path.join(artifactsDir, "review.json"), "utf8"),
  ) as RunReview;

  const variantBlocks: Array<{ vk: string; v: Variant; captions: string[] }> = [];
  for (const v of VARIANTS) {
    const vk = variantKey(v);
    const annotationJson = path.join(matrixDir, `after-${vk}.annotation.json`);
    let captions: string[] = [];
    if (await fileExists(annotationJson)) {
      const cached = JSON.parse(await fs.readFile(annotationJson, "utf8")) as {
        regions?: Array<{ caption?: string }>;
      };
      captions = (cached.regions ?? [])
        .map((r) => (typeof r.caption === "string" ? r.caption.trim() : ""))
        .filter((c) => c.length > 0);
    }
    variantBlocks.push({ vk, v, captions });
  }

  const renderImageBlock = (vk: string): string => {
    const file = `after-${vk}.annotated.full.png`;
    return `<a href="${file}"><img src="${file}" width="100%" alt="after · ${vk}"></a>`;
  };
  const renderCaptions = (captions: string[]): string =>
    captions.length === 0
      ? "_(no callouts)_"
      : captions.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const lead = variantBlocks[0];
  const others = variantBlocks.slice(1);

  const md = [
    `# Cutter Summary`,
    "",
    review.summary.replace(/^\s*\d+ steps?:[^.]*\.\s*Playwright:[^.]*\.\s*/, "").trim(),
    "",
    `### ${lead.v.device} · ${lead.v.theme} · ${lead.v.viewport.width}×${lead.v.viewport.height}`,
    "",
    renderImageBlock(lead.vk),
    "",
    renderCaptions(lead.captions),
    "",
    ...others.flatMap((b) => [
      `<details><summary><b>${b.v.device} · ${b.v.theme} · ${b.v.viewport.width}×${b.v.viewport.height}</b></summary>`,
      "",
      renderImageBlock(b.vk),
      "",
      renderCaptions(b.captions),
      "",
      "</details>",
      "",
    ]),
  ].join("\n");

  const mdPath = path.join(matrixDir, "matrix-comment.md");
  await fs.writeFile(mdPath, md);

  const html = buildCommentPreviewHtml({ pr, commentMarkdown: md });
  const htmlPath = path.join(matrixDir, "matrix-comment-preview.html");
  await fs.writeFile(htmlPath, html);

  log(`wrote matrix-comment.md + matrix-comment-preview.html`);
  log("");
  log("To post on GitHub:");
  log("  1. Drag-drop these PNGs into a draft PR comment:");
  for (const b of variantBlocks) log(`       after-${b.vk}.annotated.full.png`);
  log("  2. Replace the relative ./after-*.annotated.full.png src/href with the resulting");
  log("     user-images.githubusercontent.com URLs GitHub mints on upload.");
  log("  3. GitHub comment column is ~750-800px; width=100% will scale accordingly.");
}

function renderMatrixHtml(): string {
  const variantOrder = VARIANTS.map(variantKey);
  const rows = variantOrder
    .map((vk) => {
      const v = VARIANTS.find((x) => variantKey(x) === vk)!;
      return `
    <tr>
      <th>${v.device} · ${v.theme}<br><span class="vp">${v.viewport.width}×${v.viewport.height}</span></th>
      <td><img src="before-${vk}.png" alt="before ${vk}"></td>
      <td><img src="after-${vk}.annotated.full.png" alt="after ${vk} annotated"></td>
    </tr>`;
    })
    .join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Releasebot · PR #${PR} · matrix</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; background: #f6f7f9; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
    table { border-collapse: separate; border-spacing: 12px 16px; }
    th { text-align: left; vertical-align: top; padding-top: 8px; min-width: 140px; font-size: 13px; }
    th .vp { color: #888; font-weight: normal; }
    td { background: #fff; border: 1px solid #e2e4e8; border-radius: 6px; padding: 6px; }
    img { display: block; max-width: 720px; height: auto; }
    thead th { font-size: 14px; padding-bottom: 8px; }
    @media (prefers-color-scheme: dark) {
      body { background: #18181b; color: #ededed; }
      .sub { color: #aaa; }
      td { background: #232327; border-color: #303034; }
      th .vp { color: #888; }
    }
  </style>
</head>
<body>
  <h1>PR #${PR} · run-ledger matrix (with annotations)</h1>
  <div class="sub">/issues/LIV-1 → Activity tab · 4 variants × before/after · after side annotated by vision LLM</div>
  <table>
    <thead>
      <tr><th></th><th>before (base ${"b9a80dc"})</th><th>after (head ${"e53b1a1"}) · annotated</th></tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY required for annotation phase");
    process.exit(2);
  }

  // src dir → tools/releasebot → tools → repo root
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const prDir = path.join(repoRoot, "tmp", "releasebot", String(PR));
  const artifactsDir = path.join(prDir, "artifacts");
  const matrixDir = path.join(prDir, "matrix");
  await fs.mkdir(matrixDir, { recursive: true });
  const beforeWt = path.join(prDir, "before");
  const afterWt = path.join(prDir, "after");
  const beforeHome = path.join(beforeWt, ".paperclip-home");
  const afterHome = path.join(afterWt, ".paperclip-home");

  // Skip boot/seed entirely if all raw screenshots already exist.
  const rawAllPresent = (
    await Promise.all(
      ["before", "after"].flatMap((side) =>
        VARIANTS.map((v) =>
          fileExists(path.join(matrixDir, `${side}-${variantKey(v)}.png`)),
        ),
      ),
    )
  ).every(Boolean);

  if (!rawAllPresent) {
    const baseSpec = JSON.parse(
      await fs.readFile(path.join(artifactsDir, "fixture-spec.json"), "utf8"),
    ) as FixtureSpec;
    const adapter = new PaperclipAdapter();
    log("booting before stack...");
    const beforeStack = await adapter.boot(beforeWt, 3301, beforeHome);
    log(`  before ${beforeStack.baseUrl}`);
    log("booting after stack...");
    const afterStack = await adapter.boot(afterWt, 3302, afterHome);
    log(`  after  ${afterStack.baseUrl}`);
    let beforeDb: Awaited<ReturnType<typeof openInstanceDb>> | undefined;
    let afterDb: Awaited<ReturnType<typeof openInstanceDb>> | undefined;
    try {
      [beforeDb, afterDb] = await Promise.all([
        openInstanceDb({ paperclipHome: beforeStack.paperclipHome, instanceId: beforeStack.instanceId }),
        openInstanceDb({ paperclipHome: afterStack.paperclipHome, instanceId: afterStack.instanceId }),
      ]);
      log("seeding both sides (parallel)...");
      await Promise.all([
        executeSpec(beforeStack.baseUrl, baseSpec, undefined, beforeDb),
        executeSpec(afterStack.baseUrl, baseSpec, undefined, afterDb),
      ]);
      await capturePhase(matrixDir, beforeStack.baseUrl, afterStack.baseUrl);
    } finally {
      log("closing db pools + stacks...");
      await Promise.allSettled([beforeDb?.close(), afterDb?.close()]);
      await Promise.allSettled([beforeStack.shutdown(), afterStack.shutdown()]);
    }
  } else {
    log("all raw screenshots present — skipping boot/seed/capture");
  }

  await annotatePhase(matrixDir, artifactsDir, apiKey);

  log("rendering matrix.html...");
  const html = renderMatrixHtml();
  const htmlPath = path.join(matrixDir, "matrix.html");
  await fs.writeFile(htmlPath, html);
  log(`open: file://${htmlPath}`);

  await commentPhase(matrixDir, artifactsDir);
  log(`open: file://${path.join(matrixDir, "matrix-comment-preview.html")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
