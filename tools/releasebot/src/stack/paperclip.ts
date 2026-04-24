import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { BootedStack, SeedContext, StackAdapter } from "./adapter.ts";
import type { FixtureSpec, FixtureSummary } from "../types.ts";
import { executeFixtureSpec, synthesizeFixtureSpecFromPr } from "./paperclip-seed.ts";

const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 1_500;

export class PaperclipAdapter implements StackAdapter {
  async boot(worktree: string, port: number, homeDir: string): Promise<BootedStack> {
    // Wipe any stale state from a prior run — partial PG init leaves the data
    // dir non-empty and blocks a fresh boot with "data directory might already exist".
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.mkdir(homeDir, { recursive: true });
    const logPath = path.join(path.dirname(homeDir), `boot-${port}.log`);
    await fs.writeFile(logPath, "");
    const logStream = createWriteStream(logPath, { flags: "a" });
    await new Promise<void>((resolve) => logStream.once("open", () => resolve()));
    const env = {
      ...process.env,
      PORT: String(port),
      PAPERCLIP_HOME: homeDir,
      PAPERCLIP_INSTANCE_ID: `releasebot-${port}`,
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    };
    const proc = spawn("pnpm", ["paperclipai", "onboard", "--yes", "--run"], {
      cwd: worktree,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    proc.stdout?.pipe(logStream, { end: false });
    proc.stderr?.pipe(logStream, { end: false });
    proc.once("exit", () => logStream.end());

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(baseUrl, HEALTH_TIMEOUT_MS, proc);
    } catch (err) {
      proc.kill("SIGTERM");
      const tail = await safeTail(logPath, 60);
      throw new Error(`Paperclip stack at ${baseUrl} failed to become healthy. Last log lines:\n${tail}\n\nOriginal: ${(err as Error).message}`);
    }

    return {
      baseUrl,
      shutdown: () => shutdownProc(proc),
    };
  }

  async buildSeedSpec(ctx: SeedContext): Promise<FixtureSpec> {
    return synthesizeFixtureSpecFromPr({
      diff: ctx.diff,
      worktreePath: ctx.worktreePath,
      apiKey: ctx.apiKey,
      artifactsDir: ctx.artifactsDir,
    });
  }

  async seed(baseUrl: string, spec: FixtureSpec, artifactsDir: string, sideLabel: string): Promise<FixtureSummary> {
    return executeFixtureSpec({ baseUrl, spec, artifactsDir, sideLabel });
  }
}

async function waitForHealth(baseUrl: string, timeoutMs: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Process exited with code ${proc.exitCode} before health check passed`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${baseUrl}/api/health`);
}

async function shutdownProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) proc.kill("SIGKILL");
}

async function safeTail(file: string, lines: number): Promise<string> {
  try {
    const content = await fs.readFile(file, "utf8");
    const all = content.split("\n");
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  } catch {
    return "(no log available)";
  }
}

