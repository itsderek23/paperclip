import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFile = promisify(execFileCb);

export async function addWorktree(worktreePath: string, sha: string): Promise<void> {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  try {
    await fs.access(path.join(worktreePath, ".git"));
    return;
  } catch {}
  await execFile("git", ["worktree", "add", "--detach", worktreePath, sha]);
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  try {
    await execFile("git", ["worktree", "remove", "--force", worktreePath]);
  } catch {
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
}

export async function pnpmInstall(worktreePath: string): Promise<void> {
  // --ignore-scripts skips native postinstall builds (e.g. sharp) that fail in this repo
  // on the root install too; the runtime paths we exercise don't depend on those bindings.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], {
      cwd: worktreePath,
      stdio: "inherit",
    });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pnpm install exit ${code}`))));
    proc.on("error", reject);
  });
  // embedded-postgres's platform package ships without dylib symlinks; its postinstall
  // (skipped by --ignore-scripts) normally creates them. Run just that one hydrator.
  await hydrateEmbeddedPostgresSymlinks(worktreePath);
}

async function hydrateEmbeddedPostgresSymlinks(worktreePath: string): Promise<void> {
  const pnpmDir = path.join(worktreePath, "node_modules", ".pnpm");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(pnpmDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("@embedded-postgres+")) continue;
    const match = entry.match(/^@embedded-postgres\+([^@]+)@/);
    if (!match) continue;
    const platform = match[1];
    const script = path.join(pnpmDir, entry, "node_modules", "@embedded-postgres", platform, "scripts", "hydrate-symlinks.js");
    try {
      await fs.access(script);
    } catch {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("node", [script], {
        cwd: path.dirname(path.dirname(script)),
        stdio: "inherit",
      });
      proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`hydrate-symlinks exit ${code}`))));
      proc.on("error", reject);
    });
  }
}
