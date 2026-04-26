import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repairStepFromDom } from "./plan.ts";
import { extractSelectors } from "./plan-validate.ts";
import type { Plan, SideResult, StepResult } from "./types.ts";

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
    if (literals.length > 0 && matches.length === 0) {
      log(`  repair step ${padded}: SHAPE B — none of ${literals.length} selectors appear in rendered DOM; marking inconclusive.`);
      updatedAfter = patchStep(updatedAfter, i, {
        ...afterStep,
        status: "inconclusive",
        error:
          "Affordance text not visible in rendered DOM — likely fixture coverage gap (the seeded data does not exercise this UI path). Spec was not auto-repaired; see itsderek23/paperclip#4 for seed-revision follow-up.",
        repair: {
          outcome: "skipped_shape_b",
          reason: "No selector literal from the failing test appeared in the rendered DOM.",
          originalError: errorText,
          originalTestBody,
        },
      });
      continue;
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
          outcome: "failed",
          reason: `Repair LLM threw: ${(err as Error).message}`,
          originalError: errorText,
          originalTestBody,
        },
      });
      continue;
    }

    if ("cannotRepair" in repair) {
      log(`  repair step ${padded}: ${repair.reason}; keeping original failure.`);
      updatedAfter = patchStep(updatedAfter, i, {
        ...afterStep,
        repair: {
          outcome: "failed",
          reason: repair.reason,
          originalError: errorText,
          originalTestBody,
        },
      });
      continue;
    }

    // Snapshot original artifacts so the report can show what failed first.
    const originalSnapshot = await snapshotOriginalArtifacts(screenshotDir, padded);

    // Patch the spec in place: swap this test's body for the revised one.
    const patched = replaceTestForStep(specSource, stepN, repair.revisedTestBody);
    if (!patched) {
      log(`  repair step ${padded}: could not splice revised test back into spec; keeping original.`);
      updatedAfter = patchStep(updatedAfter, i, {
        ...afterStep,
        repair: {
          outcome: "failed",
          reason: "Splicing revised test back into the spec failed (regex did not match).",
          originalError: errorText,
          originalTestBody,
          revisedTestBody: repair.revisedTestBody,
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
        outcome: "applied",
        reason: rerunStatus.status === "pass"
          ? "Locator rewritten from rendered DOM; rerun passed."
          : "Locator rewritten from rendered DOM; rerun did not pass.",
        originalError: errorText,
        originalTestBody,
        revisedTestBody: repair.revisedTestBody,
        ...(originalSnapshot ? { originalScreenshot: path.relative(args.artifactsDir, originalSnapshot) } : {}),
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
