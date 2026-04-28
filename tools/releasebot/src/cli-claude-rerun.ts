#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPlanAgainst } from "./run.ts";
import { reviewRun } from "./review.ts";
import { annotateRun } from "./annotate.ts";
import { writeReport } from "./report.ts";
import type { Plan, PrMeta } from "./types.ts";

const log = (msg: string) => console.error(`[claude-rerun] ${msg}`);

async function main() {
  const prNumber = Number(process.argv[2]);
  const beforeUrl = process.argv[3] ?? "http://127.0.0.1:3301";
  const afterUrl = process.argv[4] ?? "http://127.0.0.1:3302";
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("Usage: tsx cli-claude-rerun.ts <PR_NUMBER> [beforeUrl] [afterUrl]");
    process.exit(2);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY required");
    process.exit(2);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..");
  const artifactsDir = path.join(repoRoot, "tmp", "releasebot", String(prNumber), "artifacts");

  const readJson = async <T>(p: string) => JSON.parse(await fs.readFile(p, "utf8")) as T;
  const pr = await readJson<PrMeta>(path.join(artifactsDir, "pr.json"));
  const plan = await readJson<Plan>(path.join(artifactsDir, "plan.json"));

  log(`PR #${pr.number} — using running stacks (before ${beforeUrl}, after ${afterUrl})`);

  log("clearing prior step artifacts...");
  for (const side of ["before", "after"] as const) {
    await fs.rm(path.join(artifactsDir, side), { recursive: true, force: true });
    await fs.rm(path.join(artifactsDir, "generated", side), { recursive: true, force: true });
  }

  log("running plan (before)...");
  const beforeResult = await runPlanAgainst(plan, beforeUrl, "before", artifactsDir);
  log("running plan (after)...");
  const afterResult = await runPlanAgainst(plan, afterUrl, "after", artifactsDir);

  log("visual review...");
  const review = await reviewRun(pr, plan, beforeResult, afterResult, { apiKey });
  await fs.writeFile(path.join(artifactsDir, "review.json"), JSON.stringify(review, null, 2));

  log("annotating...");
  try {
    await annotateRun({
      pr, plan, after: afterResult, review,
      artifactsDir, apiKey, forceReprompt: true, log,
    });
  } catch (err) {
    log(`annotate failed: ${(err as Error).message}`);
  }

  log("writing report...");
  const { commentPath, previewPath } = await writeReport({
    pr, plan, before: beforeResult, after: afterResult, review, artifactsDir,
  });
  log(`comment:  ${commentPath}`);
  log(`preview:  ${previewPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
