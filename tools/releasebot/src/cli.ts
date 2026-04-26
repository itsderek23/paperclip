#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureShaReachable, fetchPrCiSummary, fetchPrDiff, fetchPrMeta } from "./pr.ts";
import { addWorktree, removeWorktree } from "./worktree.ts";
import { PaperclipAdapter } from "./stack/paperclip.ts";
import { CalDiyAdapter } from "./stack/caldiy.ts";
import { OpenWebUiAdapter } from "./stack/openwebui.ts";
import type { StackAdapter } from "./stack/adapter.ts";
import { generatePlan } from "./plan.ts";
import { extractSelectors, findUngroundedSelectors } from "./plan-validate.ts";
import { runPlanAgainst } from "./run.ts";
import { runRepairPass } from "./repair.ts";
import { reviewRun } from "./review.ts";
import { writeReport } from "./report.ts";
import { gatherDiffContext } from "./diff-context.ts";
import type { Plan, Side } from "./types.ts";

type StackName = "paperclip" | "caldiy" | "openwebui";

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
  forceNoUi: boolean;
  noReuse: boolean;
  parallelBoot: boolean;
  stack: StackName;
  repo: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      values.set(a.slice(0, eq), a.slice(eq + 1));
      continue;
    }
    if (a === "--stack" || a === "--repo") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`Missing value for ${a}`);
        process.exit(2);
      }
      values.set(a, next);
      i++;
      continue;
    }
    flags.add(a);
  }
  const prNumber = Number(positional[0]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(
      "Usage: pnpm releasebot:pr <PR_NUMBER> [--stack paperclip|caldiy|openwebui] [--repo <path>] [--skip-install] [--keep-stacks] [--no-reuse] [--parallel-boot] [--plan-only] [--clean] [--report-only] [--review-only] [--plan-from-cache] [--force-broken] [--force-no-ui]",
    );
    process.exit(2);
  }
  const stackRaw = values.get("--stack") ?? "paperclip";
  if (stackRaw !== "paperclip" && stackRaw !== "caldiy" && stackRaw !== "openwebui") {
    console.error(`Unknown --stack ${stackRaw}; expected paperclip, caldiy, or openwebui`);
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
    forceNoUi: flags.has("--force-no-ui"),
    noReuse: flags.has("--no-reuse"),
    parallelBoot: flags.has("--parallel-boot"),
    stack: stackRaw,
    repo: values.get("--repo") ?? process.env.RELEASEBOT_REPO,
  };
}

function getAdapter(name: StackName): StackAdapter {
  switch (name) {
    case "paperclip":
      return new PaperclipAdapter();
    case "caldiy":
      return new CalDiyAdapter();
    case "openwebui":
      return new OpenWebUiAdapter();
  }
}

function resolveRepoRoot(explicit: string | undefined): string {
  if (explicit) return path.resolve(explicit);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env.local at the repo root.");
    process.exit(2);
  }

  const repoRoot = resolveRepoRoot(args.repo);
  process.chdir(repoRoot);
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

  const adapter = getAdapter(args.stack);

  if (!args.skipInstall) {
    log(`installing deps (before, stack=${args.stack})...`);
    await adapter.install(beforeWt);
    log(`installing deps (after, stack=${args.stack})...`);
    await adapter.install(afterWt);
  } else {
    log("skipping install (--skip-install)");
    for (const wt of [beforeWt, afterWt]) {
      try {
        await fs.stat(path.join(wt, "node_modules"));
      } catch {
        console.error(
          `--skip-install passed but ${wt} is missing node_modules.`,
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
  } else if (args.forceNoUi) {
    log("  no UI-relevant hunks found; proceeding anyway (--force-no-ui)");
  } else {
    log("  no UI-relevant hunks found");
    console.error(
      `releasebot: PR #${args.prNumber} has no UI-relevant hunks (no .tsx/.jsx changes under ui/).`,
    );
    console.error("There is no browsable surface to QA. Re-run with --force-no-ui to proceed anyway.");
    await writeNoUiSurfaceReport(artifactsDir, pr);
    process.exit(3);
  }

  if (args.planOnly) {
    log("generating plan from diff (no fixtures, --plan-only)...");
    const plan = await planWithGroundingRetry(pr, diff, { apiKey, sourceContext });
    await fs.writeFile(path.join(artifactsDir, "plan.json"), JSON.stringify(plan, null, 2));
    printPlan(plan);
    log(`plan written to ${path.join(artifactsDir, "plan.json")}. Exiting (--plan-only).`);
    return;
  }

  const beforeHome = path.join(prDir, "before", ".paperclip-home");
  const afterHome = path.join(prDir, "after", ".paperclip-home");
  const beforePort = 3301;
  const afterPort = 3302;

  const sides = [
    { side: "before" as Side, wt: beforeWt, port: beforePort, home: beforeHome, sha: pr.baseSha },
    { side: "after" as Side, wt: afterWt, port: afterPort, home: afterHome, sha: pr.headSha },
  ];
  const bootSide = async (s: (typeof sides)[number]) => {
    if (!args.noReuse) {
      const reused = await tryReuseStack(s.sha, args.stack, repoRoot);
      if (reused) {
        log(`  reusing running ${s.side}-side at ${reused.baseUrl} (sha ${s.sha.slice(0, 7)})`);
        return reused;
      }
    }
    await evictStackOnPort(repoRoot, s.port, s.sha);
    log(`  booting ${s.side}-side on :${s.port}...`);
    const stack = await adapter.boot(s.wt, s.port, s.home);
    await writeStackFingerprint(repoRoot, { sha: s.sha, pid: stack.pid ?? 0, port: s.port, baseUrl: stack.baseUrl, stack: args.stack });
    const innerShutdown = stack.shutdown;
    return {
      ...stack,
      shutdown: async () => {
        await innerShutdown();
        await clearStackFingerprint(repoRoot, s.sha);
      },
    };
  };

  log(`booting stacks (before :${beforePort} / after :${afterPort}${args.parallelBoot ? ", parallel" : ""})...`);
  const bootResults = args.parallelBoot
    ? await Promise.allSettled(sides.map(bootSide))
    : await (async () => {
        const out: PromiseSettledResult<Awaited<ReturnType<typeof bootSide>>>[] = [];
        for (const s of sides) {
          try {
            out.push({ status: "fulfilled", value: await bootSide(s) });
          } catch (err) {
            out.push({ status: "rejected", reason: err });
            break;
          }
        }
        while (out.length < sides.length) {
          out.push({ status: "rejected", reason: new Error("skipped after prior failure") });
        }
        return out;
      })();

  const [beforeRes, afterRes] = bootResults;
  if (beforeRes.status === "rejected" || afterRes.status === "rejected") {
    if (beforeRes.status === "rejected" && (beforeRes.reason as Error).message !== "skipped after prior failure") {
      await writeBootFailureReport(artifactsDir, pr, "before", beforeWt, beforeRes.reason as Error);
    }
    if (afterRes.status === "rejected" && (afterRes.reason as Error).message !== "skipped after prior failure") {
      await writeBootFailureReport(artifactsDir, pr, "after", afterWt, afterRes.reason as Error);
    }
    if (beforeRes.status === "fulfilled") await beforeRes.value.shutdown().catch(() => undefined);
    if (afterRes.status === "fulfilled") await afterRes.value.shutdown().catch(() => undefined);
    const errs = [
      beforeRes.status === "rejected" ? `before: ${(beforeRes.reason as Error).message}` : null,
      afterRes.status === "rejected" ? `after: ${(afterRes.reason as Error).message}` : null,
    ].filter(Boolean);
    throw new Error(`stack boot failed — ${errs.join("; ")}`);
  }
  const beforeStack = beforeRes.value;
  const afterStack = afterRes.value;

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

    let beforeAuth: Awaited<ReturnType<NonNullable<typeof adapter.provideAuth>>> | undefined;
    let afterAuth: Awaited<ReturnType<NonNullable<typeof adapter.provideAuth>>> | undefined;
    if (adapter.provideAuth) {
      log("authenticating before-side...");
      beforeAuth = await adapter
        .provideAuth(beforeStack.baseUrl, artifactsDir, "before")
        .catch((e) => {
          log(`  before auth failed: ${(e as Error).message}`);
          return undefined;
        });
      log("authenticating after-side...");
      afterAuth = await adapter
        .provideAuth(afterStack.baseUrl, artifactsDir, "after")
        .catch((e) => {
          log(`  after auth failed: ${(e as Error).message}`);
          return undefined;
        });
      if (beforeAuth) log(`  ${beforeAuth.description}`);
    }

    log("generating plan from diff...");
    const plan = await planWithGroundingRetry(pr, diff, {
      apiKey,
      fixtures,
      sourceContext,
      authContext: beforeAuth,
    });
    await fs.writeFile(path.join(artifactsDir, "plan.json"), JSON.stringify(plan, null, 2));
    printPlan(plan);

    log("running plan (before)...");
    const beforeResult = await runPlanAgainst(plan, beforeStack.baseUrl, "before", artifactsDir, beforeAuth?.storageStatePath);
    log("running plan (after)...");
    let afterResult = await runPlanAgainst(plan, afterStack.baseUrl, "after", artifactsDir, afterAuth?.storageStatePath);

    const needsRepair = afterResult.steps.some((s) => s.status === "fail");
    if (needsRepair) {
      log("repair pass: rewriting failing after-side steps from rendered DOM...");
      afterResult = await runRepairPass({ plan, before: beforeResult, after: afterResult, artifactsDir, apiKey });
    }

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

interface StackFingerprint {
  sha: string;
  pid: number;
  port: number;
  baseUrl: string;
  stack: string;
}

function stacksDir(repoRoot: string): string {
  return path.join(repoRoot, "tmp", "releasebot", ".stacks");
}

function fingerprintPath(repoRoot: string, sha: string): string {
  return path.join(stacksDir(repoRoot), `${sha}.json`);
}

async function writeStackFingerprint(repoRoot: string, fp: StackFingerprint): Promise<void> {
  const fpPath = fingerprintPath(repoRoot, fp.sha);
  await fs.mkdir(path.dirname(fpPath), { recursive: true });
  await fs.writeFile(fpPath, JSON.stringify(fp));
}

async function clearStackFingerprint(repoRoot: string, sha: string): Promise<void> {
  await fs.rm(fingerprintPath(repoRoot, sha), { force: true });
}

async function tryReuseStack(expectedSha: string, expectedStack: string, repoRoot: string): Promise<{ baseUrl: string; pid?: number; shutdown: () => Promise<void> } | null> {
  const fpPath = fingerprintPath(repoRoot, expectedSha);
  let fp: StackFingerprint;
  try {
    fp = JSON.parse(await fs.readFile(fpPath, "utf8")) as StackFingerprint;
  } catch {
    return null;
  }
  if (fp.sha !== expectedSha || fp.stack !== expectedStack) {
    await clearStackFingerprint(repoRoot, expectedSha);
    return null;
  }
  try {
    process.kill(fp.pid, 0);
  } catch {
    await clearStackFingerprint(repoRoot, expectedSha);
    return null;
  }
  try {
    await fetch(fp.baseUrl, { signal: AbortSignal.timeout(2_000) });
  } catch {
    await clearStackFingerprint(repoRoot, expectedSha);
    return null;
  }
  return {
    baseUrl: fp.baseUrl,
    pid: fp.pid,
    shutdown: async () => {
      // Reusers are consumers, not owners — leave the stack alone so the original
      // --keep-stacks invocation can keep iterating against it.
    },
  };
}

async function evictStackOnPort(repoRoot: string, port: number, keepSha: string): Promise<void> {
  const dir = stacksDir(repoRoot);
  const files = await fs.readdir(dir).catch(() => []);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const fpPath = path.join(dir, f);
    let fp: StackFingerprint;
    try {
      fp = JSON.parse(await fs.readFile(fpPath, "utf8")) as StackFingerprint;
    } catch {
      continue;
    }
    if (fp.port !== port || fp.sha === keepSha) continue;
    try {
      process.kill(fp.pid, "SIGTERM");
    } catch {}
    await fs.rm(fpPath, { force: true });
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
  const plan = await planWithGroundingRetry(pr, diff, { apiKey, sourceContext, fixtures });
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

async function planWithGroundingRetry(
  pr: Parameters<typeof generatePlan>[0],
  diff: string,
  options: Parameters<typeof generatePlan>[2],
): Promise<Plan> {
  const plan = await generatePlan(pr, diff, options);
  if (!options.sourceContext) return plan;

  const haystack = buildGroundingHaystack(options.sourceContext, options.fixtures);
  const selectors = extractSelectors(plan.spec);
  const ungrounded = findUngroundedSelectors(selectors, haystack);
  if (ungrounded.length === 0) return plan;

  log(`  ⚠ ${ungrounded.length} ungrounded selector(s) in plan: ${ungrounded.map((s) => JSON.stringify(s)).join(", ")}`);
  log("  retrying plan generation with selector feedback...");
  let retried: Plan;
  try {
    retried = await generatePlan(pr, diff, { ...options, retryFeedback: ungrounded });
  } catch (err) {
    log(`  ⚠ retry failed (${(err as Error).message}); falling back to original plan.`);
    return plan;
  }
  if (retried.metadata.steps.length === 0) {
    log("  ⚠ retry produced an empty plan; falling back to original plan.");
    return plan;
  }
  const stillUngrounded = findUngroundedSelectors(extractSelectors(retried.spec), haystack);
  if (stillUngrounded.length === 0) {
    log("  retry succeeded — all selectors are grounded.");
    return retried;
  }
  log(
    `  ⚠ retry still has ${stillUngrounded.length} ungrounded selector(s): ${stillUngrounded
      .map((s) => JSON.stringify(s))
      .join(", ")}. Proceeding; the visual review will mark steps inconclusive if Playwright cannot find them.`,
  );
  return retried;
}

function buildGroundingHaystack(sourceContext: string, fixtures: Parameters<typeof generatePlan>[2]["fixtures"]): string {
  if (!fixtures) return sourceContext;
  const fixtureValues: string[] = [];
  for (const entry of Object.values(fixtures)) {
    for (const v of Object.values(entry.values)) {
      if (typeof v === "string") fixtureValues.push(v);
      else fixtureValues.push(JSON.stringify(v));
    }
  }
  return sourceContext + "\n" + fixtureValues.join("\n");
}

async function writeNoUiSurfaceReport(
  artifactsDir: string,
  pr: { number: number; title: string; url: string; baseSha: string; headSha: string },
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# releasebot — PR #${pr.number}: skipped`);
  lines.push("");
  lines.push(`**${pr.title}**  `);
  lines.push(`${pr.url}  `);
  lines.push(`base: \`${pr.baseSha.slice(0, 7)}\` · head: \`${pr.headSha.slice(0, 7)}\`  `);
  lines.push("");
  lines.push("## No browsable UI surface in this PR");
  lines.push("");
  lines.push(
    "releasebot found no `.tsx`/`.jsx` changes under `ui/` in this PR. There is no browsable surface a visual QA run could exercise — most likely a backend, infra, docs, or skill-markdown change.",
  );
  lines.push("");
  lines.push("Re-run with `--force-no-ui` to attempt the run anyway (the planner will likely scope-drift to incidental UI hunks).");
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
