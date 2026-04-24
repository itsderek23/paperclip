import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Plan, Side, SideResult, StepResult } from "./types.ts";
import { stepScreenshotName } from "./plan.ts";
import { writeGeneratedSpec } from "./spec-generator.ts";

export async function runPlanAgainst(
  plan: Plan,
  baseUrl: string,
  side: Side,
  artifactsDir: string,
): Promise<SideResult> {
  const screenshotDir = path.join(artifactsDir, side);
  await fs.mkdir(screenshotDir, { recursive: true });

  const generatedDir = path.join(artifactsDir, "generated", side);
  const testOutputDir = path.join(generatedDir, "test-output");
  await fs.mkdir(testOutputDir, { recursive: true });

  const annotateHelper = resolveAnnotateHelperPath();
  const { specPath, configPath } = await writeGeneratedSpec({
    outDir: generatedDir,
    specBody: plan.spec,
    annotateHelperAbsPath: annotateHelper,
  });

  await runPlaywright({
    configPath,
    cwd: generatedDir,
    env: {
      RELEASEBOT_BASE_URL: baseUrl,
      RELEASEBOT_SCREENSHOT_DIR: screenshotDir,
      RELEASEBOT_RUN_OUTPUT: testOutputDir,
    },
  });

  const steps = await parseResults(
    path.join(generatedDir, "results.json"),
    plan.metadata.steps.length,
    screenshotDir,
  );

  const result: SideResult = { side, baseUrl, steps };
  await fs.writeFile(path.join(screenshotDir, "steps.json"), JSON.stringify(result, null, 2));
  // Stash specPath for the report renderer (no schema change needed; it's inferable from artifacts dir).
  void specPath;
  return result;
}

function resolveAnnotateHelperPath(): string {
  // tools/releasebot/src/run.ts → tools/releasebot/src/runtime/annotate.ts
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "runtime", "annotate.ts");
}

async function runPlaywright(opts: {
  configPath: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<void> {
  // Resolve the Playwright test runner CLI inside the tool's own node_modules,
  // regardless of where the CLI is invoked from. Avoids relying on PATH.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const playwrightCli = path.resolve(here, "..", "node_modules", "@playwright", "test", "cli.js");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [playwrightCli, "test", "--config", opts.configPath, "--reporter=json,list"],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: "inherit",
      },
    );
    proc.on("exit", (code) => {
      // Non-zero exit is expected when tests fail; JSON reporter still writes results.json.
      // Resolve unconditionally — `parseResults` reads the JSON and handles per-step pass/fail.
      void code;
      resolve();
    });
    proc.on("error", reject);
  });
}

async function parseResults(
  resultsPath: string,
  expectedStepCount: number,
  screenshotDir: string,
): Promise<StepResult[]> {
  let raw: string;
  try {
    raw = await fs.readFile(resultsPath, "utf8");
  } catch {
    // Playwright crashed before writing results — synthesize failures for every step.
    return blankStepResults(expectedStepCount, screenshotDir, "Playwright did not produce results.json");
  }
  const parsed = JSON.parse(raw) as PlaywrightReport;
  const testCases = flattenTests(parsed);
  const byNumber = new Map<number, PlaywrightTestCase>();
  for (const tc of testCases) {
    const m = tc.title.match(/^step-(\d+)\b/);
    if (!m) continue;
    byNumber.set(Number(m[1]), tc);
  }

  const steps: StepResult[] = [];
  for (let n = 1; n <= expectedStepCount; n++) {
    const tc = byNumber.get(n);
    const screenshot = path.join(screenshotDir, stepScreenshotName(n));
    if (!tc) {
      steps.push({
        step_n: n,
        status: "fail",
        error: `No Playwright test matched step-${String(n).padStart(2, "0")}`,
        screenshot,
      });
      continue;
    }
    const lastResult = tc.results[tc.results.length - 1];
    const status = lastResult?.status === "passed" ? "pass" : "fail";
    const error =
      status === "fail" ? summarizeError(lastResult) : undefined;
    steps.push({ step_n: n, status, error, screenshot });
  }
  return steps;
}

function blankStepResults(count: number, screenshotDir: string, error: string): StepResult[] {
  const out: StepResult[] = [];
  for (let n = 1; n <= count; n++) {
    out.push({
      step_n: n,
      status: "fail",
      error,
      screenshot: path.join(screenshotDir, stepScreenshotName(n)),
    });
  }
  return out;
}

function summarizeError(result: PlaywrightResult | undefined): string {
  if (!result) return "unknown failure";
  if (result.error?.message) return result.error.message.split("\n").slice(0, 3).join(" ").slice(0, 400);
  if (result.status === "timedOut") return "timed out";
  return result.status;
}

function flattenTests(report: PlaywrightReport): PlaywrightTestCase[] {
  const out: PlaywrightTestCase[] = [];
  const visit = (suite: PlaywrightSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const tc of spec.tests ?? []) {
        out.push({ title: spec.title, results: tc.results ?? [] });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return out;
}

// Minimal shape of the Playwright JSON reporter output that we read.
interface PlaywrightReport {
  suites?: PlaywrightSuite[];
}
interface PlaywrightSuite {
  specs?: Array<{
    title: string;
    tests?: Array<{
      results?: PlaywrightResult[];
    }>;
  }>;
  suites?: PlaywrightSuite[];
}
interface PlaywrightTestCase {
  title: string;
  results: PlaywrightResult[];
}
interface PlaywrightResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  error?: { message?: string; stack?: string };
}
