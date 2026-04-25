import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { request as playwrightRequest } from "playwright";
import type { BootedStack, StackAdapter } from "./adapter.ts";
import type { AuthContext, Side } from "../types.ts";

const HEALTH_TIMEOUT_MS = 240_000;
const HEALTH_POLL_MS = 1_500;

const ADMIN_URL_DEFAULT = "postgresql://postgres:postgres@localhost:5432/postgres";
const NEXTAUTH_SECRET = "releasebot-nextauth-secret-change-me";
const ENCRYPTION_KEY = "releasebot-32byte-encryption-key";
const CALCOM_LICENSE_KEY = "";

export class CalDiyAdapter implements StackAdapter {
  async install(worktree: string): Promise<void> {
    await runStreaming("yarn", ["install", "--immutable"], worktree).catch(async () => {
      await runStreaming("yarn", ["install"], worktree);
    });
  }

  async boot(worktree: string, port: number, homeDir: string): Promise<BootedStack> {
    await fs.mkdir(homeDir, { recursive: true });
    const logPath = path.join(path.dirname(homeDir), `boot-${port}.log`);
    await fs.writeFile(logPath, "");

    const dbName = dbNameForHome(homeDir);
    const adminUrl = process.env.RELEASEBOT_PG_ADMIN_URL ?? ADMIN_URL_DEFAULT;
    const dbUrl = replaceDbName(adminUrl, dbName);

    await dropDatabase(adminUrl, dbName);
    await createDatabase(adminUrl, dbName);

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: dbUrl,
      DATABASE_DIRECT_URL: dbUrl,
      NEXTAUTH_SECRET,
      NEXTAUTH_URL: `http://localhost:${port}`,
      CALENDSO_ENCRYPTION_KEY: ENCRYPTION_KEY,
      CALCOM_LICENSE_KEY,
      NEXT_PUBLIC_IS_E2E: "1",
      NEXT_PUBLIC_WEBAPP_URL: `http://localhost:${port}`,
      NODE_OPTIONS: "--dns-result-order=ipv4first",
    };

    await runStreaming("yarn", ["prisma", "generate"], worktree, baseEnv, logPath);
    await runStreaming("yarn", ["workspace", "@calcom/prisma", "db-deploy"], worktree, baseEnv, logPath);
    await runStreaming("yarn", ["db-seed"], worktree, baseEnv, logPath);
    await runStreaming("yarn", ["workspace", "@calcom/web", "copy-app-store-static"], worktree, baseEnv, logPath);
    await patchNextConfigSkipTypeCheck(path.join(worktree, "apps", "web", "next.config.ts"));
    await runStreaming("yarn", ["workspace", "@calcom/web", "build"], worktree, baseEnv, logPath);

    const logStream = createWriteStream(logPath, { flags: "a" });
    await new Promise<void>((resolve) => logStream.once("open", () => resolve()));
    const proc = spawn("yarn", ["workspace", "@calcom/web", "start", "-p", String(port)], {
      cwd: worktree,
      env: baseEnv,
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
      const tail = await safeTail(logPath, 80);
      throw new Error(
        `cal.diy stack at ${baseUrl} failed to become healthy. Last log lines:\n${tail}\n\nOriginal: ${(err as Error).message}`,
      );
    }

    return {
      baseUrl,
      pid: proc.pid,
      shutdown: async () => {
        await shutdownProc(proc);
        await dropDatabase(adminUrl, dbName).catch(() => undefined);
      },
    };
  }

  async provideAuth(baseUrl: string, artifactsDir: string, sideLabel: Side): Promise<AuthContext | undefined> {
    const email = process.env.RELEASEBOT_CALDIY_USER ?? "pro@example.com";
    const password = process.env.RELEASEBOT_CALDIY_PASSWORD ?? "pro";
    const sideDir = path.join(artifactsDir, sideLabel);
    await fs.mkdir(sideDir, { recursive: true });
    const storageStatePath = path.join(sideDir, "storageState.json");

    const ctx = await playwrightRequest.newContext({ baseURL: baseUrl });
    try {
      const csrfRes = await ctx.get("/api/auth/csrf");
      if (!csrfRes.ok()) {
        throw new Error(`GET /api/auth/csrf returned ${csrfRes.status()}`);
      }
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

      const loginRes = await ctx.post("/api/auth/callback/credentials", {
        form: {
          email,
          password,
          callbackURL: baseUrl,
          redirect: "false",
          json: "true",
          csrfToken,
        },
      });
      if (loginRes.status() !== 200) {
        throw new Error(`POST /api/auth/callback/credentials returned ${loginRes.status()}: ${await loginRes.text()}`);
      }

      await ctx.get("/e2e/session-warmup").catch(() => undefined);

      await ctx.storageState({ path: storageStatePath });
      await injectTimezoneDialogCookie(storageStatePath, baseUrl);
    } finally {
      await ctx.dispose();
    }

    return {
      storageStatePath,
      description: `logged in as ${email} (cal.diy seeded user)`,
    };
  }
}

async function injectTimezoneDialogCookie(storageStatePath: string, baseUrl: string): Promise<void> {
  const raw = await fs.readFile(storageStatePath, "utf8");
  const state = JSON.parse(raw) as { cookies: unknown[]; origins: unknown[] };
  const host = new URL(baseUrl).hostname;
  state.cookies.push({
    name: "calcom-timezone-dialog",
    value: "1",
    domain: host,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  });
  await fs.writeFile(storageStatePath, JSON.stringify(state));
}

const RELEASEBOT_PATCH_MARKER = "// __RELEASEBOT_SKIP_TSC__";

async function patchNextConfigSkipTypeCheck(configPath: string): Promise<void> {
  const original = await fs.readFile(configPath, "utf8");
  if (original.includes(RELEASEBOT_PATCH_MARKER)) return;
  const target = "export default (phase: string): NextConfig => plugins.reduce((acc, plugin) => plugin(acc), nextConfig(phase));";
  if (!original.includes(target)) {
    throw new Error(`patchNextConfigSkipTypeCheck: anchor line not found in ${configPath}`);
  }
  const replacement = [
    RELEASEBOT_PATCH_MARKER,
    "const __releasebotInner = (phase: string): NextConfig => plugins.reduce((acc, plugin) => plugin(acc), nextConfig(phase));",
    "export default (phase: string): NextConfig => {",
    "  const cfg = __releasebotInner(phase) as NextConfig & { typescript?: Record<string, unknown>; eslint?: Record<string, unknown> };",
    "  cfg.typescript = { ...(cfg.typescript ?? {}), ignoreBuildErrors: true };",
    "  cfg.eslint = { ...(cfg.eslint ?? {}), ignoreDuringBuilds: true };",
    "  return cfg as NextConfig;",
    "};",
  ].join("\n");
  await fs.writeFile(configPath, original.replace(target, replacement));
}

function dbNameForHome(homeDir: string): string {
  const parts = homeDir.split(path.sep).filter(Boolean);
  const side = parts[parts.length - 2] ?? "side";
  const pr = parts[parts.length - 3] ?? "x";
  const sanitized = `releasebot_${pr}_${side}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  return sanitized.slice(0, 60);
}

function replaceDbName(adminUrl: string, dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function createDatabase(adminUrl: string, dbName: string): Promise<void> {
  await runPsql(adminUrl, `CREATE DATABASE "${dbName}";`);
}

async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  await runPsql(
    adminUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
  ).catch(() => undefined);
  await runPsql(adminUrl, `DROP DATABASE IF EXISTS "${dbName}";`);
}

function runPsql(adminUrl: string, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: "pipe" });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += String(d)));
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`psql exited ${code}: ${stderr.trim()}`))));
    proc.on("error", reject);
  });
}

function runStreaming(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  logPath?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = logPath ? createWriteStream(logPath, { flags: "a" }) : undefined;
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: stream ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (stream) {
      proc.stdout?.pipe(stream, { end: false });
      proc.stderr?.pipe(stream, { end: false });
    }
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
    proc.on("error", reject);
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Process exited with code ${proc.exitCode} before health check passed`);
    }
    try {
      const res = await fetch(`${baseUrl}/auth/login`, {
        signal: AbortSignal.timeout(2_000),
        redirect: "manual",
      });
      if (res.status >= 200 && res.status < 400) return;
    } catch {}
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${baseUrl}/auth/login`);
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
