#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureShaReachable, fetchPrDiff, fetchPrMeta } from "./pr.ts";
import { addWorktree, pnpmInstall, removeWorktree } from "./worktree.ts";
import { PaperclipAdapter } from "./stack/paperclip.ts";
import { generatePlan } from "./plan.ts";
import { runPlanAgainst } from "./run.ts";
import { reviewRun } from "./review.ts";
import { writeReport } from "./report.ts";
import { gatherDiffContext } from "./diff-context.ts";
import type { Plan, Side } from "./types.ts";

interface Args {
  prNumber: number;
  skipInstall: boolean;
  keepStacks: boolean;
  planOnly: boolean;
  clean: boolean;
  reportOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const prNumber = Number(positional[0]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("Usage: pnpm releasebot:pr <PR_NUMBER> [--skip-install] [--keep-stacks] [--plan-only] [--clean] [--report-only]");
    process.exit(2);
  }
  return {
    prNumber,
    skipInstall: flags.has("--skip-install"),
    keepStacks: flags.has("--keep-stacks"),
    planOnly: flags.has("--plan-only"),
    clean: flags.has("--clean"),
    reportOnly: flags.has("--report-only"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env.local at the repo root.");
    process.exit(2);
  }

  const repoRoot = findRepoRoot();
  const prDir = path.join(repoRoot, "tmp", "releasebot", String(args.prNumber));
  const artifactsDir = path.join(prDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });

  log(`releasebot · PR #${args.prNumber}`);

  if (args.reportOnly) {
    await regenerateReport(artifactsDir);
    return;
  }

  log("fetching PR metadata + diff...");
  const pr = await fetchPrMeta(args.prNumber);
  const diff = await fetchPrDiff(args.prNumber);
  await fs.writeFile(path.join(artifactsDir, "pr.json"), JSON.stringify(pr, null, 2));
  await fs.writeFile(path.join(artifactsDir, "diff.patch"), diff);
  log(`  ${pr.title}`);
  log(`  base ${pr.baseSha.slice(0, 7)} · head ${pr.headSha.slice(0, 7)}`);

  log("ensuring SHAs are reachable...");
  await ensureShaReachable(pr.baseSha, args.prNumber);
  await ensureShaReachable(pr.headSha, args.prNumber);

  log("preparing worktrees...");
  const beforeWt = path.join(prDir, "before");
  const afterWt = path.join(prDir, "after");
  await addWorktree(beforeWt, pr.baseSha);
  await addWorktree(afterWt, pr.headSha);

  if (!args.skipInstall) {
    log("pnpm install (before)...");
    await pnpmInstall(beforeWt);
    log("pnpm install (after)...");
    await pnpmInstall(afterWt);
  } else {
    log("skipping pnpm install (--skip-install)");
  }

  log("gathering source context around diff hunks...");
  const sourceContext = await gatherDiffContext(diff, afterWt);
  if (sourceContext) {
    await fs.writeFile(path.join(artifactsDir, "source-context.txt"), sourceContext);
    const hunkCount = (sourceContext.match(/^---\s/gm) ?? []).length;
    log(`  ${hunkCount} hunk(s) of source context gathered (${sourceContext.length} chars)`);
  } else {
    log("  no UI-relevant hunks found; proceeding without source context");
  }

  if (args.planOnly) {
    log("generating plan from diff (no fixtures, --plan-only)...");
    const plan = await generatePlan(pr, diff, { apiKey, sourceContext });
    await fs.writeFile(path.join(artifactsDir, "plan.json"), JSON.stringify(plan, null, 2));
    printPlan(plan);
    log(`plan written to ${path.join(artifactsDir, "plan.json")}. Exiting (--plan-only).`);
    return;
  }

  const adapter = new PaperclipAdapter();
  const beforeHome = path.join(prDir, "before", ".paperclip-home");
  const afterHome = path.join(prDir, "after", ".paperclip-home");
  const beforePort = 3301;
  const afterPort = 3302;

  log(`booting stack (before) on :${beforePort}...`);
  const beforeStack = await adapter.boot(beforeWt, beforePort, beforeHome);
  let afterStack;
  try {
    log(`booting stack (after) on :${afterPort}...`);
    afterStack = await adapter.boot(afterWt, afterPort, afterHome);
  } catch (err) {
    await beforeStack.shutdown();
    throw err;
  }

  try {
    let fixtures: Awaited<ReturnType<NonNullable<typeof adapter.seed>>> | undefined;
    if (adapter.buildSeedSpec && adapter.seed) {
      log("building seed spec (reading adjacent tests + synthesizing via LLM)...");
      const spec = await adapter
        .buildSeedSpec({ diff, apiKey, artifactsDir, worktreePath: afterWt })
        .catch((e) => {
          log(`  seed spec generation failed: ${(e as Error).message}`);
          return undefined;
        });
      if (spec) {
        log(`  spec has ${spec.entities.length} entities — executing on both sides`);
        const beforeFixtures = await adapter
          .seed(beforeStack.baseUrl, spec, artifactsDir, "before")
          .catch((e) => {
            log(`  before seed failed: ${(e as Error).message}`);
            return undefined;
          });
        await adapter
          .seed(afterStack.baseUrl, spec, artifactsDir, "after")
          .catch((e) => log(`  after seed failed: ${(e as Error).message}`));
        fixtures = beforeFixtures;
      }
    }

    log("generating plan from diff...");
    const plan = await generatePlan(pr, diff, { apiKey, fixtures, sourceContext });
    await fs.writeFile(path.join(artifactsDir, "plan.json"), JSON.stringify(plan, null, 2));
    printPlan(plan);

    log("running plan (before)...");
    const beforeResult = await runPlanAgainst(plan, beforeStack.baseUrl, "before", artifactsDir);
    log("running plan (after)...");
    const afterResult = await runPlanAgainst(plan, afterStack.baseUrl, "after", artifactsDir);

    log("visual review...");
    const review = await reviewRun(pr, plan, beforeResult, afterResult, { apiKey });
    await fs.writeFile(path.join(artifactsDir, "review.json"), JSON.stringify(review, null, 2));

    log("writing report...");
    const { markdownPath, htmlPath } = await writeReport({
      pr,
      plan,
      before: beforeResult,
      after: afterResult,
      review,
      artifactsDir,
    });

    printSummary(plan, review, markdownPath, htmlPath);
  } finally {
    if (!args.keepStacks) {
      log("shutting down stacks...");
      await Promise.allSettled([beforeStack.shutdown(), afterStack!.shutdown()]);
    } else {
      log(`leaving stacks up: ${beforeStack.baseUrl} (before) / ${afterStack!.baseUrl} (after)`);
    }
  }

  if (args.clean) {
    if (args.keepStacks) {
      log("--clean ignored (conflicts with --keep-stacks)");
    } else {
      log("cleaning worktrees (keeping artifacts/)...");
      await Promise.allSettled([removeWorktree(beforeWt), removeWorktree(afterWt)]);
      const sizeMb = await dirSizeMb(artifactsDir);
      log(`  worktrees removed; artifacts/ retained (${sizeMb} MB)`);
    }
  }
}

async function regenerateReport(artifactsDir: string): Promise<void> {
  log("regenerating report from existing artifacts...");
  const read = async (name: string): Promise<unknown> =>
    JSON.parse(await fs.readFile(path.join(artifactsDir, name), "utf8"));
  const pr = (await read("pr.json")) as Parameters<typeof writeReport>[0]["pr"];
  const plan = (await read("plan.json")) as Plan;
  const review = (await read("review.json")) as Parameters<typeof writeReport>[0]["review"];
  const before = (await read(path.join("before", "steps.json"))) as Parameters<typeof writeReport>[0]["before"];
  const after = (await read(path.join("after", "steps.json"))) as Parameters<typeof writeReport>[0]["after"];
  const { markdownPath, htmlPath } = await writeReport({ pr, plan, before, after, review, artifactsDir });
  log(`  markdown: ${markdownPath}`);
  log(`  html:     ${htmlPath}`);
}

async function dirSizeMb(dir: string): Promise<number> {
  let total = 0;
  async function walk(p: string): Promise<void> {
    const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      const abs = path.join(p, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile()) total += (await fs.stat(abs).catch(() => ({ size: 0 }))).size;
    }
  }
  await walk(dir);
  return Math.round(total / (1024 * 1024));
}

function findRepoRoot(): string {
  // tools/releasebot/src/cli.ts → .. .. ..
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function printPlan(plan: Plan): void {
  console.log("");
  console.log(`  Title: ${plan.metadata.title}`);
  console.log(`  Goal:  ${plan.metadata.goal}`);
  console.log(`  Rationale: ${plan.metadata.rationale}`);
  console.log(`  Steps:`);
  for (const [i, s] of plan.metadata.steps.entries()) {
    console.log(`    ${i + 1}. ${s.description}`);
    console.log(`       ${s.url}`);
  }
  console.log("");
}

function printSummary(plan: Plan, review: { summary: string; steps: Array<{ verdict: string }> }, md: string, html: string): void {
  const counts: Record<string, number> = {};
  for (const s of review.steps) counts[s.verdict] = (counts[s.verdict] ?? 0) + 1;
  console.log("");
  console.log(`  ${plan.metadata.steps.length} step(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  console.log(`  ${review.summary}`);
  console.log("");
  console.log(`  markdown: ${md}`);
  console.log(`  html:     ${html}`);
  console.log("");
}

main().catch((err) => {
  console.error("releasebot failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
