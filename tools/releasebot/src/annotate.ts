import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runVision, type AnnotatorContext, type Region } from "./annotators.ts";
import { renderPinCardSpotlightCropped } from "./annotate-render.ts";
import type { BBox, Plan, PrMeta, RunReview, SideResult } from "./types.ts";

interface PersistedAnnotation {
  step_n: number;
  regions: Region[];
  promptedAt: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readBboxes(p: string): Promise<BBox[]> {
  try {
    const text = await fs.readFile(p, "utf8");
    return JSON.parse(text) as BBox[];
  } catch {
    return [];
  }
}

async function readCachedAnnotation(p: string): Promise<PersistedAnnotation | null> {
  try {
    const text = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(text) as PersistedAnnotation;
    if (!Array.isArray(parsed.regions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function annotateRun(args: {
  pr: PrMeta;
  plan: Plan;
  after: SideResult;
  review: RunReview;
  artifactsDir: string;
  apiKey: string;
  forceReprompt: boolean;
  log?: (msg: string) => void;
}): Promise<void> {
  const log = args.log ?? ((msg: string) => console.error(msg));
  const afterDir = path.join(args.artifactsDir, "after");
  const beforeDir = path.join(args.artifactsDir, "before");

  for (const [idx, planStep] of args.plan.metadata.steps.entries()) {
    const stepN = idx + 1;
    const padded = String(stepN).padStart(2, "0");
    const afterPng = path.join(afterDir, `step-${padded}.png`);
    const beforePng = path.join(beforeDir, `step-${padded}.png`);
    const annotationJson = path.join(afterDir, `step-${padded}.annotation.json`);
    const annotatedPng = path.join(afterDir, `step-${padded}.annotated.png`);
    const annotatedFullPng = path.join(afterDir, `step-${padded}.annotated.full.png`);
    const bboxesPath = path.join(afterDir, `step-${padded}.bboxes.json`);
    const htmlPath = path.join(afterDir, `step-${padded}.html`);

    if (!(await fileExists(afterPng))) {
      log(`  step ${stepN}: no after screenshot — skipping annotation`);
      continue;
    }
    if (!(await fileExists(beforePng))) {
      log(`  step ${stepN}: no before screenshot — skipping annotation`);
      continue;
    }

    try {
      const meta = await sharp(afterPng).metadata();
      const W = meta.width ?? 1440;
      const H = meta.height ?? 900;

      let regions: Region[];
      const cached = args.forceReprompt ? null : await readCachedAnnotation(annotationJson);
      if (cached) {
        log(`  step ${stepN}: using cached annotation (${cached.regions.length} regions)`);
        regions = cached.regions;
      } else {
        log(`  step ${stepN}: prompting vision annotator...`);
        const observation = args.review.steps.find((s) => s.step_n === stepN)?.observation ?? "";
        const ctx: AnnotatorContext = {
          rawPngPath: afterPng,
          htmlPath: (await fileExists(htmlPath)) ? htmlPath : undefined,
          plannerBboxes: await readBboxes(bboxesPath),
          stepDescription: planStep.description,
          planRationale: args.plan.metadata.rationale,
          reviewObservation: observation,
          prTitle: args.pr.title,
          imageWidth: W,
          imageHeight: H,
        };
        const result = await runVision(ctx, beforePng, { apiKey: args.apiKey });
        if (result.errorMessage) {
          log(`  step ${stepN}: vision annotator error: ${result.errorMessage}`);
        }
        regions = result.regions;
        const persist: PersistedAnnotation = {
          step_n: stepN,
          regions,
          promptedAt: new Date().toISOString(),
        };
        await fs.writeFile(annotationJson, JSON.stringify(persist, null, 2), "utf8");
      }

      if (regions.length === 0) {
        log(`  step ${stepN}: no regions produced — skipping render`);
        continue;
      }

      await renderPinCardSpotlightCropped(afterPng, regions, annotatedPng, annotatedFullPng, W, H);
      log(`  step ${stepN}: wrote ${path.relative(args.artifactsDir, annotatedPng)} + ${path.relative(args.artifactsDir, annotatedFullPng)}`);
    } catch (err) {
      log(`  step ${stepN}: annotate failed: ${(err as Error).message}`);
    }
  }
}

export function annotatedScreenshotPath(screenshotPath: string): string {
  return screenshotPath.replace(/\.png$/, ".annotated.png");
}

export function annotatedFullScreenshotPath(screenshotPath: string): string {
  return screenshotPath.replace(/\.png$/, ".annotated.full.png");
}

export async function preferAnnotated(screenshotPath: string): Promise<string> {
  const annotated = annotatedScreenshotPath(screenshotPath);
  return (await fileExists(annotated)) ? annotated : screenshotPath;
}
