#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PaperclipAdapter } from "./stack/paperclip.ts";
import { executeSpec } from "./stack/paperclip-seed.ts";
import { openInstanceDb, type DbContext } from "./stack/db.ts";
import { runPlanAgainst } from "./run.ts";
import { reviewRun } from "./review.ts";
import { annotateRun } from "./annotate.ts";
import { writeReport } from "./report.ts";
import type { FixtureSpec, FixtureSummary, Plan, PrMeta } from "./types.ts";

const log = (msg: string) => console.error(`[claude-driver] ${msg}`);

function interpolatePlan(plan: Plan, fixtures: FixtureSummary): Plan {
  const subst = (s: string) =>
    s.replace(/\{\{([a-z0-9_]+)\.([a-z0-9_]+)\}\}/gi, (_m, name: string, field: string) => {
      const v = fixtures[name]?.values?.[field];
      return v ?? `{{${name}.${field}}}`;
    });
  return {
    metadata: {
      ...plan.metadata,
      steps: plan.metadata.steps.map((s) => ({ ...s, url: subst(s.url) })),
    },
    spec: subst(plan.spec),
  };
}

async function main() {
  const prNumber = Number(process.argv[2]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("Usage: tsx tools/cutter/src/cli-claude.ts <PR_NUMBER>");
    process.exit(2);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY required");
    process.exit(2);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..");
  const prDir = path.join(repoRoot, "tmp", "releasebot", String(prNumber));
  const artifactsDir = path.join(prDir, "artifacts");
  const beforeWt = path.join(prDir, "before");
  const afterWt = path.join(prDir, "after");
  const beforeHome = path.join(beforeWt, ".paperclip-home");
  const afterHome = path.join(afterWt, ".paperclip-home");

  const readJson = async <T>(p: string): Promise<T> =>
    JSON.parse(await fs.readFile(p, "utf8")) as T;

  const pr = await readJson<PrMeta>(path.join(artifactsDir, "pr.json"));
  const plan = await readJson<Plan>(path.join(artifactsDir, "plan.json"));
  const baseSpec = await fs.readFile(path.join(artifactsDir, "fixture-spec.json"), "utf8")
    .then((s) => JSON.parse(s) as FixtureSpec)
    .catch(() => ({ rationale: "(no base spec)", entities: [] } as FixtureSpec));
  const seedExtPath = path.join(prDir, "seed-extension.json");
  const seedExt = await fs.readFile(seedExtPath, "utf8")
    .then((s) => JSON.parse(s) as FixtureSpec)
    .catch(() => null);

  log(`PR #${pr.number} — ${pr.title}`);
  log(`base ${pr.baseSha.slice(0, 7)} · head ${pr.headSha.slice(0, 7)}`);

  const adapter = new PaperclipAdapter();
  log("booting stacks (serial — avoids embedded-postgres port race)...");
  const beforeStack = await adapter.boot(beforeWt, 3301, beforeHome);
  log(`  before ${beforeStack.baseUrl}`);
  const afterStack = await adapter.boot(afterWt, 3302, afterHome);
  log(`  after  ${afterStack.baseUrl}`);

  let beforeDb: DbContext | undefined;
  let afterDb: DbContext | undefined;
  try {
    log("opening db connections (before + after)...");
    [beforeDb, afterDb] = await Promise.all([
      openInstanceDb({ paperclipHome: beforeStack.paperclipHome, instanceId: beforeStack.instanceId }),
      openInstanceDb({ paperclipHome: afterStack.paperclipHome, instanceId: afterStack.instanceId }),
    ]);

    log("seeding base fixtures on both sides (parallel)...");
    const [beforeFixtures, afterFixtures] = await Promise.all([
      executeSpec(beforeStack.baseUrl, baseSpec, undefined, beforeDb),
      executeSpec(afterStack.baseUrl, baseSpec, undefined, afterDb),
    ]);
    await fs.writeFile(
      path.join(artifactsDir, "fixtures.before.json"),
      JSON.stringify(beforeFixtures, null, 2),
    );

    if (seedExt) {
      log(`seeding ${seedExt.entities.length}-entity extension on after-side only...`);
      const merged = await executeSpec(afterStack.baseUrl, seedExt, afterFixtures, afterDb);
      await fs.writeFile(
        path.join(artifactsDir, "fixtures.after.json"),
        JSON.stringify(merged, null, 2),
      );
      for (const e of seedExt.entities) {
        const entry = merged[e.name];
        const id = entry?.values?.id ?? "(no id)";
        const note = entry?.note ? ` — ${entry.note}` : "";
        log(`  ${e.name}: ${id}${note}`);
      }
    } else {
      log("no seed-extension.json — using base fixtures as-is on after");
      await fs.writeFile(
        path.join(artifactsDir, "fixtures.after.json"),
        JSON.stringify(afterFixtures, null, 2),
      );
    }

    log("clearing prior step artifacts...");
    for (const side of ["before", "after"] as const) {
      await fs.rm(path.join(artifactsDir, side), { recursive: true, force: true });
      await fs.rm(path.join(artifactsDir, "generated", side), { recursive: true, force: true });
    }

    const beforePlan = interpolatePlan(plan, beforeFixtures);
    const afterPlan = interpolatePlan(plan, seedExt
      ? await readJson<FixtureSummary>(path.join(artifactsDir, "fixtures.after.json"))
      : afterFixtures);

    log("running plan (before)...");
    const beforeResult = await runPlanAgainst(beforePlan, beforeStack.baseUrl, "before", artifactsDir);
    log("running plan (after)...");
    const afterResult = await runPlanAgainst(afterPlan, afterStack.baseUrl, "after", artifactsDir);

    log("visual review...");
    const review = await reviewRun(pr, plan, beforeResult, afterResult, { apiKey });
    await fs.writeFile(
      path.join(artifactsDir, "review.json"),
      JSON.stringify(review, null, 2),
    );

    log("annotating after screenshots...");
    try {
      await annotateRun({
        pr,
        plan,
        after: afterResult,
        review,
        artifactsDir,
        apiKey,
        forceReprompt: true,
        log,
      });
    } catch (err) {
      log(`annotate failed: ${(err as Error).message}`);
    }

    log("writing report...");
    const { commentPath, previewPath } = await writeReport({
      pr,
      plan,
      before: beforeResult,
      after: afterResult,
      review,
      artifactsDir,
    });
    log(`comment:  ${commentPath}`);
    log(`preview:  ${previewPath}`);
  } finally {
    log("closing db pools...");
    await Promise.allSettled([beforeDb?.close(), afterDb?.close()]);
    log("shutting down stacks...");
    await Promise.allSettled([beforeStack.shutdown(), afterStack.shutdown()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
