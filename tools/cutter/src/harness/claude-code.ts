import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { FixtureSpec, Plan, PlanMetadata } from "../types.ts";

export interface RunHarnessArgs {
  systemPrompt: string;
  worktreePath: string;
  artifactsDir: string;
  budgetUsd?: number;
  log?: (msg: string) => void;
}

export interface HarnessResult {
  plan: Plan;
  baseSeed: FixtureSpec | null;
  seedExtension: FixtureSpec | null;
  rawOutput: string;
  cost: { usd?: number; durationMs?: number };
}

const DEFAULT_BUDGET_USD = 2.0;
const USER_MESSAGE = "Generate the plan now per the system prompt. Output ONLY the JSON object — no markdown fences, no commentary.";

export async function runPlanHarness(args: RunHarnessArgs): Promise<HarnessResult> {
  const log = args.log ?? (() => {});
  const budget = args.budgetUsd ?? DEFAULT_BUDGET_USD;

  await fs.mkdir(args.artifactsDir, { recursive: true });
  const promptFile = path.join(args.artifactsDir, "harness-system-prompt.md");
  await fs.writeFile(promptFile, args.systemPrompt);

  const cliArgs = [
    "-p", USER_MESSAGE,
    "--system-prompt-file", promptFile,
    "--allowed-tools", "Read", "Grep", "Bash",
    "--permission-mode", "bypassPermissions",
    "--output-format", "json",
    "--max-budget-usd", String(budget),
    "--no-session-persistence",
  ];

  log(`spawning claude -p (cwd=${args.worktreePath}, budget=$${budget}, prompt=${(args.systemPrompt.length / 1024).toFixed(1)}KB)`);
  const startedAt = Date.now();
  const stdout = await spawnCapture("claude", cliArgs, args.worktreePath);
  const durationMs = Date.now() - startedAt;

  await fs.writeFile(path.join(args.artifactsDir, "harness-stdout.json"), stdout);

  const envelope = parseClaudeEnvelope(stdout);
  await fs.writeFile(
    path.join(args.artifactsDir, "harness-result.txt"),
    typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result, null, 2),
  );

  const inner = extractInnerJson(envelope.result);
  validateHarnessShape(inner);
  validatePlan(inner.plan);

  log(`harness produced plan in ${(durationMs / 1000).toFixed(1)}s, cost $${envelope.totalCostUsd?.toFixed(3) ?? "?"}`);

  return {
    plan: inner.plan,
    baseSeed: inner.baseSeed ?? null,
    seedExtension: inner.seedExtension ?? null,
    rawOutput: stdout,
    cost: { usd: envelope.totalCostUsd, durationMs },
  };
}

function spawnCapture(cmd: string, argv: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited ${code}\nstderr:\n${stderr.slice(0, 4000)}`));
    });
  });
}

interface ClaudeEnvelope {
  result: string;
  totalCostUsd?: number;
  isError?: boolean;
  subtype?: string;
}

function parseClaudeEnvelope(stdout: string): ClaudeEnvelope {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("claude -p returned empty stdout");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`claude -p stdout was not valid JSON: ${(err as Error).message}\nFirst 400 chars:\n${trimmed.slice(0, 400)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`claude -p stdout was not a JSON object: ${typeof parsed}`);
  }
  const env = parsed as Record<string, unknown>;
  if (env.is_error || env.isError) {
    throw new Error(`claude -p reported error subtype=${String(env.subtype)} result=${JSON.stringify(env.result).slice(0, 400)}`);
  }
  const result = env.result;
  if (typeof result !== "string") {
    throw new Error(`claude -p envelope missing string .result; got ${typeof result}`);
  }
  return {
    result,
    totalCostUsd: typeof env.total_cost_usd === "number" ? env.total_cost_usd : undefined,
    isError: Boolean(env.is_error),
    subtype: typeof env.subtype === "string" ? env.subtype : undefined,
  };
}

interface HarnessJson {
  plan: Plan;
  baseSeed?: FixtureSpec | null;
  seedExtension?: FixtureSpec | null;
}

function extractInnerJson(text: string): HarnessJson {
  const candidate = stripFences(text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const sliced = sliceLargestObject(candidate);
    if (!sliced) {
      throw new Error(`harness response was not valid JSON: ${(err as Error).message}\nFirst 400 chars:\n${candidate.slice(0, 400)}`);
    }
    parsed = JSON.parse(sliced);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`harness response was not a JSON object`);
  }
  return parsed as HarnessJson;
}

function stripFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1];
  return text;
}

function sliceLargestObject(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return text.slice(first, last + 1);
}

function validateHarnessShape(obj: unknown): asserts obj is HarnessJson {
  if (!obj || typeof obj !== "object") throw new Error("harness output is not an object");
  const o = obj as Record<string, unknown>;
  if (!o.plan || typeof o.plan !== "object") {
    throw new Error("harness output missing .plan object");
  }
  for (const key of ["baseSeed", "seedExtension"] as const) {
    const v = o[key];
    if (v !== undefined && v !== null && typeof v !== "object") {
      throw new Error(`harness output .${key} must be a FixtureSpec object or null`);
    }
  }
}

function validatePlan(p: { metadata?: PlanMetadata; spec?: string }): void {
  if (!p.metadata) throw new Error("plan missing metadata");
  const meta = p.metadata;
  if (!Array.isArray(meta.steps)) throw new Error("plan metadata.steps must be an array");
  if (meta.surface === "none") {
    if (meta.steps.length !== 0) {
      throw new Error('plan declared surface: "none" but metadata.steps is non-empty');
    }
    if (!meta.rationale || meta.rationale.trim().length === 0) {
      throw new Error('plan declared surface: "none" but rationale is empty');
    }
    return;
  }
  if (meta.steps.length === 0) throw new Error("plan metadata has no steps");
  for (const [i, step] of meta.steps.entries()) {
    if (!step.url?.startsWith("/")) throw new Error(`step ${i + 1} url must be relative`);
    if (!step.description) throw new Error(`step ${i + 1} missing description`);
  }
  if (typeof p.spec !== "string" || p.spec.trim().length === 0) {
    throw new Error("plan spec body is empty");
  }
  const testCount = (p.spec.match(/\btest\(/g) ?? []).length;
  if (testCount === 0) throw new Error("plan spec contains no test(...) calls");
  if (testCount !== meta.steps.length) {
    throw new Error(`plan spec has ${testCount} test(...) calls but metadata declares ${meta.steps.length} steps`);
  }
}
