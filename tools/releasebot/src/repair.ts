import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repairStepFromDom } from "./plan.ts";
import { extractSelectors } from "./plan-validate.ts";
import { applySeedExtension, readExistingExtension, reviseSeedFromFailure } from "./reseed.ts";
import type { FixtureSpec, FixtureSummary, Plan, SideResult, StepResult } from "./types.ts";

const log = (msg: string): void => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

export async function runRepairPass(args: {
  plan: Plan;
  before: SideResult;
  after: SideResult;
  artifactsDir: string;
  apiKey: string;
}): Promise<SideResult> {
  const { plan, before, after, artifactsDir, apiKey } = args;
  const generatedDir = path.join(artifactsDir, "generated", "after");
  const screenshotDir = path.join(artifactsDir, "after");
  const specPath = path.join(generatedDir, "generated.spec.ts");
  const configPath = path.join(generatedDir, "playwright.config.ts");

  let updatedAfter: SideResult = after;
  let specSource: string | null = null;

  for (let i = 0; i < after.steps.length; i++) {
    const afterStep = updatedAfter.steps[i];
    const beforeStep = before.steps[i];
    const stepMeta = plan.metadata.steps[i];
    if (!afterStep || !beforeStep || !stepMeta) continue;

    const decision = classifyForRepair(afterStep, beforeStep);
    if (decision === "skip") continue;

    const stepN = afterStep.step_n;
    const padded = String(stepN).padStart(2, "0");
    const errorText = afterStep.error ?? "";

    if (specSource === null) {
      try {
        specSource = await fs.readFile(specPath, "utf8");
      } catch {
        log(`  repair: could not read spec at ${specPath}; aborting repair pass.`);
        return updatedAfter;
      }
    }

    const originalTestBody = extractTestForStep(specSource, stepN);
    if (!originalTestBody) {
      log(`  repair step ${padded}: could not locate test block in spec; skipping.`);
      continue;
    }

    const domPath = path.join(screenshotDir, `step-${padded}.html`);
    let domHtml: string;
    try {
      domHtml = await fs.readFile(domPath, "utf8");
    } catch {
      log(`  repair step ${padded}: no DOM snapshot at ${domPath}; skipping.`);
      continue;
    }

    // Shape A vs. Shape B guard: do any of the literal selector strings appear in the DOM?
    const literals = extractSelectors(originalTestBody);
    const haystack = domHtml.toLowerCase();
    const matches = literals.filter((lit) => lit.length >= 3 && haystack.includes(lit.toLowerCase()));
    let shapeBExtensionApplied = false;
    let shapeBRationale: string | undefined;
    let shapeBAddedEntities: string[] | undefined;
    if (literals.length > 0 && matches.length === 0) {
      log(`  repair step ${padded}: SHAPE B detected — none of ${literals.length} selectors appear in rendered DOM; attempting seed extension...`);
      const extResult = await tryExtendSeed({
        apiKey,
        artifactsDir: args.artifactsDir,
        afterBaseUrl: after.baseUrl,
        failedStepDescription: stepMeta.description,
        failedStepUrl: stepMeta.url,
        failureSummary: errorText,
        domHtml,
        screenshotPath: path.join(screenshotDir, `step-${padded}.png`),
      });
      if ("error" in extResult) {
        log(`  repair step ${padded}: ${extResult.error}; marking inconclusive.`);
        updatedAfter = patchStep(updatedAfter, i, {
          ...afterStep,
          status: "inconclusive",
          error:
            "Affordance text not visible in rendered DOM and seed extension did not recover. " + extResult.error,
          repair: {
            outcome: "seed_extension_failed",
            reason: extResult.error,
            originalError: errorText,
            originalTestBody,
          },
        });
        continue;
      }

      // Seed extension succeeded. Snapshot originals before the rerun overwrites them.
      const originalSnapshot = await snapshotOriginalArtifacts(screenshotDir, padded);

      // Try the original test verbatim against the now-extended fixtures.
      const grepPattern = `step-${padded}`;
      log(`  repair step ${padded}: seed extended (added ${extResult.addedEntities.join(", ") || "none"}); re-running original test with --grep "${grepPattern}"...`);
      await runPlaywrightGrep({ configPath, cwd: generatedDir, grep: grepPattern, baseUrl: after.baseUrl, screenshotDir });
      const verbatimRerun = await readPlaywrightStatusForStep(path.join(generatedDir, "results.json"), stepN);

      if (verbatimRerun.status === "pass") {
        log(`  repair step ${padded}: original test passed against extended seed.`);
        updatedAfter = patchStep(updatedAfter, i, {
          ...afterStep,
          status: "pass",
          error: undefined,
          screenshot: path.join(screenshotDir, `step-${padded}.png`),
          bboxes: await readBboxes(screenshotDir, padded),
          repair: {
            outcome: "seed_extended",
            reason: "Original test passed after seed extension added the missing data shape.",
            originalError: errorText,
            originalTestBody,
            seedExtensionRationale: extResult.rationale,
            addedEntities: extResult.addedEntities,
            ...(originalSnapshot ? { originalScreenshot: path.relative(args.artifactsDir, originalSnapshot) } : {}),
          },
        });
        continue;
      }

      // Original test still fails — fall through to Shape A repair against the new DOM.
      // The afterEach hook overwrote step-NN.html with the post-extension DOM, so we re-read it.
      try {
        domHtml = await fs.readFile(domPath, "utf8");
      } catch {
        log(`  repair step ${padded}: post-extension DOM not readable; keeping seed-extended status as fail.`);
        updatedAfter = patchStep(updatedAfter, i, {
          ...afterStep,
          status: "fail",
          error: verbatimRerun.error ?? errorText,
          screenshot: path.join(screenshotDir, `step-${padded}.png`),
          bboxes: await readBboxes(screenshotDir, padded),
          repair: {
            outcome: "seed_extension_failed",
            reason: "Seed extension applied but post-extension DOM was unreadable.",
            originalError: errorText,
            originalTestBody,
            seedExtensionRationale: extResult.rationale,
            addedEntities: extResult.addedEntities,
          },
        });
        continue;
      }
      shapeBExtensionApplied = true;
      shapeBRationale = extResult.rationale;
      shapeBAddedEntities = extResult.addedEntities;
      // Stash the originalSnapshot path on the closure so the post-rewrite branch can attach it.
      // We achieve this by writing it into `afterStep.repair?.originalScreenshot` via the main branch below.
      // The flow continues — fall through to repairStepFromDom (which only sees `domHtml` and current state).
      // We mark the pre-rewrite originalSnapshot via a side-channel by re-using the same screenshotDir conventions:
      // the *.original.* files are already in place from snapshotOriginalArtifacts above.
      void originalSnapshot;
    }

    log(`  repair step ${padded}: calling LLM to rewrite from rendered DOM (${literals.length} literals, ${matches.length} grounded)...`);
    let repair: Awaited<ReturnType<typeof repairStepFromDom>>;
    try {
      repair = await repairStepFromDom({
        apiKey,
        stepDescription: stepMeta.description,
        originalTestBody,
        failureSummary: errorText,
        domHtml,
      });
    } catch (err) {
      log(`  repair step ${padded}: LLM call threw (${(err as Error).message}); keeping original failure.`);
      updatedAfter = patchStep(updatedAfter, i, {
        ...afterStep,
        repair: {
          outcome: shapeBExtensionApplied ? "seed_extension_failed" : "failed",
          reason: `Repair LLM threw: ${(err as Error).message}`,
          originalError: errorText,
          originalTestBody,
          ...(shapeBRationale ? { seedExtensionRationale: shapeBRationale } : {}),
          ...(shapeBAddedEntities ? { addedEntities: shapeBAddedEntities } : {}),
        },
      });
      continue;
    }

    if ("cannotRepair" in repair) {
      log(`  repair step ${padded}: ${repair.reason}; keeping original failure.`);
      updatedAfter = patchStep(updatedAfter, i, {
        ...afterStep,
        repair: {
          outcome: shapeBExtensionApplied ? "seed_extension_failed" : "failed",
          reason: repair.reason,
          originalError: errorText,
          originalTestBody,
          ...(shapeBRationale ? { seedExtensionRationale: shapeBRationale } : {}),
          ...(shapeBAddedEntities ? { addedEntities: shapeBAddedEntities } : {}),
        },
      });
      continue;
    }

    // Snapshot original artifacts so the report can show what failed first — UNLESS the Shape B
    // path already snapshotted them above (in which case `step-NN.original.*` already holds the
    // pre-anything failure state, and re-running snapshot here would overwrite that with the
    // intermediate post-extension run).
    let originalSnapshot: string | undefined;
    if (shapeBExtensionApplied) {
      originalSnapshot = path.join(screenshotDir, `step-${padded}.original.png`);
      try {
        await fs.access(originalSnapshot);
      } catch {
        originalSnapshot = undefined;
      }
    } else {
      originalSnapshot = await snapshotOriginalArtifacts(screenshotDir, padded);
    }

    // Patch the spec in place: swap this test's body for the revised one.
    const patched = replaceTestForStep(specSource, stepN, repair.revisedTestBody);
    if (!patched) {
      log(`  repair step ${padded}: could not splice revised test back into spec; keeping original.`);
      updatedAfter = patchStep(updatedAfter, i, {
        ...afterStep,
        repair: {
          outcome: shapeBExtensionApplied ? "seed_extension_failed" : "failed",
          reason: "Splicing revised test back into the spec failed (regex did not match).",
          originalError: errorText,
          originalTestBody,
          revisedTestBody: repair.revisedTestBody,
          ...(shapeBRationale ? { seedExtensionRationale: shapeBRationale } : {}),
          ...(shapeBAddedEntities ? { addedEntities: shapeBAddedEntities } : {}),
        },
      });
      continue;
    }
    await fs.writeFile(specPath, patched, "utf8");
    specSource = patched;

    // Re-run only this test by Playwright --grep on the step name.
    const grepPattern = `step-${padded}`;
    log(`  repair step ${padded}: re-running with --grep "${grepPattern}"...`);
    await runPlaywrightGrep({ configPath, cwd: generatedDir, grep: grepPattern, baseUrl: after.baseUrl, screenshotDir });

    // Re-parse just this step's result.
    const rerunStatus = await readPlaywrightStatusForStep(path.join(generatedDir, "results.json"), stepN);
    const newScreenshot = path.join(screenshotDir, `step-${padded}.png`);
    log(`  repair step ${padded}: rerun status=${rerunStatus.status}${rerunStatus.error ? " · " + rerunStatus.error.slice(0, 120) : ""}`);

    updatedAfter = patchStep(updatedAfter, i, {
      ...afterStep,
      status: rerunStatus.status,
      error: rerunStatus.error,
      screenshot: newScreenshot,
      bboxes: await readBboxes(screenshotDir, padded),
      repair: {
        outcome: shapeBExtensionApplied
          ? (rerunStatus.status === "pass" ? "seed_extended" : "seed_extension_failed")
          : "applied",
        reason: shapeBExtensionApplied
          ? (rerunStatus.status === "pass"
              ? "Seed extended and locator rewritten from rendered DOM; rerun passed."
              : "Seed extended and locator rewritten from rendered DOM; rerun did not pass.")
          : (rerunStatus.status === "pass"
              ? "Locator rewritten from rendered DOM; rerun passed."
              : "Locator rewritten from rendered DOM; rerun did not pass."),
        originalError: errorText,
        originalTestBody,
        revisedTestBody: repair.revisedTestBody,
        ...(originalSnapshot ? { originalScreenshot: path.relative(args.artifactsDir, originalSnapshot) } : {}),
        ...(shapeBRationale ? { seedExtensionRationale: shapeBRationale } : {}),
        ...(shapeBAddedEntities ? { addedEntities: shapeBAddedEntities } : {}),
      },
    });
  }

  // Persist the updated after-side steps.json.
  await fs.writeFile(path.join(screenshotDir, "steps.json"), JSON.stringify(updatedAfter, null, 2));
  return updatedAfter;
}

function classifyForRepair(after: StepResult, before: StepResult): "repair" | "skip" {
  void before;
  if (after.status !== "fail") return "skip";
  const raw = after.error ?? "";
  if (!raw) return "skip";
  const err = raw.replace(/\x1b\[[0-9;]*m/g, ""); // strip ANSI color codes
  // Skip content-mismatch failures (toHaveText / toEqual / received-vs-expected with concrete values).
  if (/Expected:\s+[^\n]+\s*Received:/i.test(err)) return "skip";
  // Locator-not-found and visibility/timeout failures are repair candidates — these typically mean
  // the locator didn't match anything (or matched something not visible / not yet rendered),
  // which is exactly what re-grounding from the rendered DOM is for.
  if (/element\(s\) not found/i.test(err)) return "repair";
  if (/toBeVisible.*failed/i.test(err)) return "repair";
  if (/Test timeout of \d+ms exceeded/i.test(err)) return "repair";
  if (/locator\.(waitFor|click|fill|hover|press)/i.test(err)) return "repair";
  return "skip";
}

function patchStep(side: SideResult, index: number, replacement: StepResult): SideResult {
  const steps = side.steps.slice();
  steps[index] = replacement;
  return { ...side, steps };
}

function extractTestForStep(spec: string, stepN: number): string | null {
  const padded = String(stepN).padStart(2, "0");
  // Match `test("step-NN · ...", async ({ page }) => { ... });` — find the body
  // by anchoring on `=> {` so we don't capture the destructuring `{ page }` brace.
  const startRe = new RegExp(`test\\(\\s*["'\`]step-${padded}\\b[\\s\\S]*?=>\\s*\\{`, "m");
  const m = startRe.exec(spec);
  if (!m) return null;
  const bodyOpenIdx = m.index + m[0].length - 1; // index of the body `{`
  const end = findMatchingBraceEnd(spec, bodyOpenIdx);
  if (end < 0) return null;
  // Continue past `}` to the closing `)` and optional `;`
  let i = end + 1;
  while (i < spec.length && /\s/.test(spec[i])) i++;
  if (spec[i] !== ")") return null;
  i++;
  while (i < spec.length && /[\s;]/.test(spec[i])) {
    if (spec[i] === ";") { i++; break; }
    i++;
  }
  return spec.slice(m.index, i);
}

function replaceTestForStep(spec: string, stepN: number, replacement: string): string | null {
  const original = extractTestForStep(spec, stepN);
  if (!original) return null;
  return spec.replace(original, replacement.trim());
}

function findMatchingBraceEnd(s: string, openIdx: number): number {
  let depth = 0;
  let inSingle = false, inDouble = false, inBacktick = false, inLine = false, inBlock = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : "";
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "/" && prev === "*") inBlock = false;
      continue;
    }
    if (inSingle) {
      if (c === "\\") { i++; continue; }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (c === "\\") { i++; continue; }
      if (c === "`") inBacktick = false;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") { inLine = true; continue; }
    if (c === "/" && s[i + 1] === "*") { inBlock = true; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "`") { inBacktick = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

async function snapshotOriginalArtifacts(screenshotDir: string, padded: string): Promise<string | undefined> {
  const png = path.join(screenshotDir, `step-${padded}.png`);
  const html = path.join(screenshotDir, `step-${padded}.html`);
  const bboxes = path.join(screenshotDir, `step-${padded}.bboxes.json`);
  const crop = path.join(screenshotDir, `step-${padded}.crop.png`);
  const targets: Array<[string, string]> = [
    [png, png.replace(/\.png$/, ".original.png")],
    [html, html.replace(/\.html$/, ".original.html")],
    [bboxes, bboxes.replace(/\.bboxes\.json$/, ".original.bboxes.json")],
    [crop, crop.replace(/\.crop\.png$/, ".original.crop.png")],
  ];
  let savedPng: string | undefined;
  for (const [src, dst] of targets) {
    try {
      await fs.rename(src, dst);
      if (src === png) savedPng = dst;
    } catch {
      // file may not exist (e.g. no bboxes captured); skip.
    }
  }
  return savedPng;
}

async function readBboxes(screenshotDir: string, padded: string): Promise<{ x: number; y: number; width: number; height: number }[] | undefined> {
  try {
    const raw = await fs.readFile(path.join(screenshotDir, `step-${padded}.bboxes.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const out: { x: number; y: number; width: number; height: number }[] = [];
    for (const r of parsed) {
      if (
        r && typeof r === "object" &&
        typeof r.x === "number" && typeof r.y === "number" &&
        typeof r.width === "number" && typeof r.height === "number"
      ) {
        out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function runPlaywrightGrep(opts: {
  configPath: string;
  cwd: string;
  grep: string;
  baseUrl: string;
  screenshotDir: string;
}): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const releasebotNodeModules = path.resolve(here, "..", "node_modules");
  const playwrightCli = path.join(releasebotNodeModules, "@playwright", "test", "cli.js");
  const existingNodePath = process.env.NODE_PATH ?? "";
  const nodePath = existingNodePath
    ? `${releasebotNodeModules}${path.delimiter}${existingNodePath}`
    : releasebotNodeModules;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [playwrightCli, "test", "--config", opts.configPath, "--grep", opts.grep],
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          NODE_PATH: nodePath,
          RELEASEBOT_BASE_URL: opts.baseUrl,
          RELEASEBOT_SCREENSHOT_DIR: opts.screenshotDir,
          RELEASEBOT_RUN_OUTPUT: path.join(opts.cwd, "test-output"),
        },
        stdio: "inherit",
      },
    );
    proc.on("exit", () => resolve());
    proc.on("error", reject);
  });
}

async function readPlaywrightStatusForStep(
  resultsPath: string,
  stepN: number,
): Promise<{ status: "pass" | "fail"; error?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(resultsPath, "utf8");
  } catch {
    return { status: "fail", error: "Playwright did not produce results.json on rerun" };
  }
  const padded = String(stepN).padStart(2, "0");
  const parsed = JSON.parse(raw) as PlaywrightReport;
  const tcs: PlaywrightTestCase[] = [];
  const visit = (s: PlaywrightSuite): void => {
    for (const spec of s.specs ?? []) {
      for (const tc of spec.tests ?? []) {
        tcs.push({ title: spec.title, results: tc.results ?? [] });
      }
    }
    for (const child of s.suites ?? []) visit(child);
  };
  for (const s of parsed.suites ?? []) visit(s);
  const tc = tcs.find((t) => t.title.includes(`step-${padded}`));
  if (!tc) return { status: "fail", error: `Rerun produced no result for step-${padded}` };
  const last = tc.results[tc.results.length - 1];
  const status = last?.status === "passed" ? "pass" : "fail";
  if (status === "pass") return { status: "pass" };
  return {
    status: "fail",
    error: last?.error?.message?.split("\n").slice(0, 3).join(" ").slice(0, 400) ?? last?.status ?? "rerun failed",
  };
}

interface ExtendSeedSuccess {
  rationale: string;
  addedEntities: string[];
  mergedFixtures: FixtureSummary;
}

async function tryExtendSeed(opts: {
  apiKey: string;
  artifactsDir: string;
  afterBaseUrl: string;
  failedStepDescription: string;
  failedStepUrl: string;
  failureSummary: string;
  domHtml: string;
  screenshotPath: string;
}): Promise<ExtendSeedSuccess | { error: string }> {
  const { apiKey, artifactsDir, afterBaseUrl, failedStepDescription, failedStepUrl, failureSummary, domHtml, screenshotPath } = opts;

  // Idempotency guard: if a previous run already extended the seed for this PR/SHA, skip the
  // LLM call and the apply (POSTs are not idempotent — re-running would create duplicates).
  const existingExtension = await readExistingExtension(artifactsDir);
  if (existingExtension && existingExtension.entities.length > 0) {
    return {
      error: `Seed extension already applied in a prior run (fixture-spec.extension.json exists with ${existingExtension.entities.length} entities). Use --no-reuse to start from a clean stack.`,
    };
  }

  // Read the inputs we need to reason about: original spec, current after-side fixtures, and the diff.
  let originalSpec: FixtureSpec;
  try {
    originalSpec = JSON.parse(await fs.readFile(path.join(artifactsDir, "fixture-spec.json"), "utf8")) as FixtureSpec;
  } catch (err) {
    return { error: `could not read fixture-spec.json: ${(err as Error).message}` };
  }
  let existingFixtures: FixtureSummary;
  try {
    existingFixtures = JSON.parse(await fs.readFile(path.join(artifactsDir, "fixtures.after.json"), "utf8")) as FixtureSummary;
  } catch (err) {
    return { error: `could not read fixtures.after.json: ${(err as Error).message}` };
  }
  let diff: string;
  try {
    diff = await fs.readFile(path.join(artifactsDir, "diff.patch"), "utf8");
  } catch (err) {
    return { error: `could not read diff.patch: ${(err as Error).message}` };
  }

  // Screenshot is optional — we send it multimodally so the LLM can visually
  // confirm the page is the intended one (vs. a 404 / wrong-page navigation).
  let screenshotBytes: Uint8Array | undefined;
  try {
    screenshotBytes = await fs.readFile(screenshotPath);
  } catch {
    // OK — fall back to text-only.
  }

  let revision: Awaited<ReturnType<typeof reviseSeedFromFailure>>;
  try {
    revision = await reviseSeedFromFailure({
      apiKey,
      originalSpec,
      existingFixtures,
      failedStepDescription,
      failedStepUrl,
      failureSummary,
      domHtml,
      diff,
      screenshotBytes,
    });
  } catch (err) {
    return { error: `seed-revision LLM call threw: ${(err as Error).message}` };
  }
  if ("cannotExtend" in revision) {
    return { error: `LLM declined seed extension: ${revision.reason}` };
  }

  // Apply the extension to the after stack.
  let applied: Awaited<ReturnType<typeof applySeedExtension>>;
  try {
    applied = await applySeedExtension({
      baseUrl: afterBaseUrl,
      existingFixtures,
      extensionEntities: revision.extensionEntities,
      artifactsDir,
      rationale: revision.rationale,
    });
  } catch (err) {
    return { error: `applying seed extension failed: ${(err as Error).message}` };
  }
  if (applied.failedEntityNames.length === revision.extensionEntities.length) {
    return { error: `all ${revision.extensionEntities.length} extension entities failed to POST.` };
  }

  return {
    rationale: revision.rationale,
    addedEntities: applied.appliedEntities
      .filter((e) => !applied.failedEntityNames.includes(e.name))
      .map((e) => e.name),
    mergedFixtures: applied.mergedFixtures,
  };
}

interface PlaywrightReport { suites?: PlaywrightSuite[] }
interface PlaywrightSuite {
  specs?: Array<{ title: string; tests?: Array<{ results?: PlaywrightResult[] }> }>;
  suites?: PlaywrightSuite[];
}
interface PlaywrightTestCase { title: string; results: PlaywrightResult[] }
interface PlaywrightResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  error?: { message?: string; stack?: string };
}
