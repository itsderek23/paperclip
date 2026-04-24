#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureShaReachable, fetchPrCiSummary, fetchPrDiff, fetchPrMeta } from "./pr.ts";
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
  reviewOnly: boolean;
  planFromCache: boolean;
  forceBroken: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const prNumber = Number(positional[0]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(
      "Usage: pnpm releasebot:pr <PR_NUMBER> [--skip-install] [--keep-stacks] [--plan-only] [--clean] [--report-only] [--review-only] [--plan-from-cache] [--force-broken]",
    );
    process.exit(2);
  }
  return {
    prNumber,
    skipInstall: flags.has("--skip-install"),
    keepStacks: flags.has("--keep-stacks"),
    planOnly: flags.has("--plan-only"),
    clean: flags.has("--clean"),
    reportOnly: flags.has("--report-only"),
    reviewOnly: flags.has("--review-only"),
    planFromCache: flags.has("--plan-from-cache"),
    forceBroken: flags.has("--force-broken"),
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

  if (args.reviewOnly) {
    await rereviewFromCache(artifactsDir, apiKey);
    return;
  }

  if (args.planFromCache) {
    await replanFromCache(artifactsDir, apiKey);
    return;
  }

  log("fetching PR metadata + diff...");
  const pr = await fetchPrMeta(args.prNumber);
  const diff = await fetchPrDiff(args.prNumber);
  await fs.writeFile(path.join(artifactsDir, "pr.json"), JSON.stringify(pr, null, 2));
  await fs.writeFile(path.join(artifactsDir, "diff.patch"), diff);
  log(`  ${pr.title}`);
  log(`  base ${pr.baseSha.slice(0, 7)} · head ${pr.headSha.slice(0, 7)}`);

  log("checking upstream CI status...");
  try {
    const ci = await fetchPrCiSummary(args.prNumber);
    if (ci.failingChecks.length > 0 || ci.mergeable === "CONFLICTING") {
      const bits: string[] = [];
      if (ci.mergeable === "CONFLICTING") bits.push("merge conflicts");
      if (ci.failingChecks.length > 0) {
        bits.push(`failing checks: ${ci.failingChecks.map((c) => c.name).join(", ")}`);
      }
      log(`  ⚠ upstream issues: ${bits.join("; ")}`);
      if (!args.forceBroken) {
        console.error(
          `releasebot: PR #${args.prNumber} has ${bits.join(" and ")}; the after-side stack is likely to fail to build.`,
        );
        console.error("Re-run with --force-broken to proceed anyway.");
        await writePreflightFailureReport(artifactsDir, pr, ci);
        process.exit(3);
      }
      log("  proceeding anyway (--force-broken)");
    } else {
      log("  upstream CI green; no conflicts");
    }
  } catch (err) {
    log(`  skipped (could not fetch CI status: ${(err as Error).message})`);
  }

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
    for (const wt of [beforeWt, afterWt]) {
      const tsxCli = path.join(wt, "cli/node_modules/tsx/dist/cli.mjs");
      try {
        await fs.stat(tsxCli);
      } catch {
        console.error(
          `--skip-install passed but ${wt} is missing node_modules (checked ${path.relative(repoRoot, tsxCli)}).`,
        );
        console.error("Re-run without --skip-install to install dependencies in the fresh worktree.");
        process.exit(2);
      }
    }
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
  let beforeStack;
  try {
    beforeStack = await adapter.boot(beforeWt, beforePort, beforeHome);
  } catch (err) {
    await writeBootFailureReport(artifactsDir, pr, "before", beforeWt, err as Error);
    throw err;
  }
  let afterStack;
  try {
    log(`booting stack (after) on :${afterPort}...`);
    afterStack = await adapter.boot(afterWt, afterPort, afterHome);
  } catch (err) {
    await writeBootFailureReport(artifactsDir, pr, "after", afterWt, err as Error);
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

async function rereviewFromCache(artifactsDir: string, apiKey: string): Promise<void> {
  log("re-running review + report from cached artifacts (no stacks, no Playwright)...");
  const read = async (name: string): Promise<unknown> =>
    JSON.parse(await fs.readFile(path.join(artifactsDir, name), "utf8"));
  const pr = (await read("pr.json")) as Parameters<typeof reviewRun>[0];
  const plan = (await read("plan.json")) as Plan;
  const before = (await read(path.join("before", "steps.json"))) as Parameters<typeof reviewRun>[2];
  const after = (await read(path.join("after", "steps.json"))) as Parameters<typeof reviewRun>[3];
  log("  visual review...");
  const review = await reviewRun(pr, plan, before, after, { apiKey });
  await fs.writeFile(path.join(artifactsDir, "review.json"), JSON.stringify(review, null, 2));
  log("  writing report...");
  const { markdownPath, htmlPath } = await writeReport({ pr, plan, before, after, review, artifactsDir });
  console.log("");
  console.log(`  ${review.summary}`);
  console.log("");
  log(`  markdown: ${markdownPath}`);
  log(`  html:     ${htmlPath}`);
}

async function replanFromCache(artifactsDir: string, apiKey: string): Promise<void> {
  log("re-running plan from cached artifacts (no stacks, no Playwright)...");
  const pr = JSON.parse(await fs.readFile(path.join(artifactsDir, "pr.json"), "utf8")) as Parameters<
    typeof generatePlan
  >[0];
  const diff = await fs.readFile(path.join(artifactsDir, "diff.patch"), "utf8");
  const sourceContext = await fs
    .readFile(path.join(artifactsDir, "source-context.txt"), "utf8")
    .catch(() => undefined);
  const fixtures = await fs
    .readFile(path.join(artifactsDir, "fixtures.before.json"), "utf8")
    .then((raw) => JSON.parse(raw) as Parameters<typeof generatePlan>[2]["fixtures"])
    .catch(() => undefined);
  const plan = await generatePlan(pr, diff, { apiKey, sourceContext, fixtures });
  await fs.writeFile(path.join(artifactsDir, "plan.json"), JSON.stringify(plan, null, 2));
  printPlan(plan);
  log(`plan written to ${path.join(artifactsDir, "plan.json")}`);
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

async function writePreflightFailureReport(
  artifactsDir: string,
  pr: { number: number; title: string; url: string; baseSha: string; headSha: string },
  ci: { mergeable: string; failingChecks: { name: string; detailsUrl: string }[] },
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# releasebot — PR #${pr.number}: skipped`);
  lines.push("");
  lines.push(`**${pr.title}**  `);
  lines.push(`${pr.url}  `);
  lines.push(`base: \`${pr.baseSha.slice(0, 7)}\` · head: \`${pr.headSha.slice(0, 7)}\`  `);
  lines.push("");
  lines.push("## Preflight skipped this run");
  lines.push("");
  lines.push("releasebot did not build or execute this PR because upstream CI shows it is not in a buildable state.");
  lines.push("");
  if (ci.mergeable === "CONFLICTING") {
    lines.push("- Merge conflicts with the base branch.");
  }
  for (const c of ci.failingChecks) {
    lines.push(`- Failing check: \`${c.name}\`${c.detailsUrl ? ` — ${c.detailsUrl}` : ""}`);
  }
  lines.push("");
  lines.push("Re-run with `--force-broken` to attempt the run anyway.");
  lines.push("");
  await fs.writeFile(path.join(artifactsDir, "report.md"), lines.join("\n"));
}

async function writeBootFailureReport(
  artifactsDir: string,
  pr: { number: number; title: string; url: string; baseSha: string; headSha: string },
  side: Side,
  worktreePath: string,
  err: Error,
): Promise<void> {
  const bootLog = path.join(worktreePath, side === "before" ? "boot-3301.log" : "boot-3302.log");
  let tail = "";
  try {
    const raw = await fs.readFile(bootLog, "utf8");
    tail = raw.split("\n").slice(-40).join("\n");
  } catch {
    tail = "(boot log not available)";
  }
  const lines: string[] = [];
  lines.push(`# releasebot — PR #${pr.number}: stack boot failed (${side})`);
  lines.push("");
  lines.push(`**${pr.title}**  `);
  lines.push(`${pr.url}  `);
  lines.push(`base: \`${pr.baseSha.slice(0, 7)}\` · head: \`${pr.headSha.slice(0, 7)}\`  `);
  lines.push("");
  lines.push(`## The ${side}-side stack failed to boot`);
  lines.push("");
  lines.push("No plan was executed; no screenshots were captured.");
  lines.push("");
  lines.push(`**Error:** ${err.message.split("\n")[0]}`);
  lines.push("");
  lines.push(`**Boot log tail** (\`${path.relative(path.dirname(artifactsDir), bootLog)}\`):`);
  lines.push("");
  lines.push("```");
  lines.push(tail);
  lines.push("```");
  lines.push("");
  await fs.writeFile(path.join(artifactsDir, "report.md"), lines.join("\n"));
}

main().catch((err) => {
  console.error("releasebot failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
