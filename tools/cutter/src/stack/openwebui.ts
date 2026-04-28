import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BootedStack, StackAdapter } from "./adapter.ts";
import type { AuthContext, Side } from "../types.ts";

const HEALTH_TIMEOUT_MS = 480_000;
const HEALTH_POLL_MS = 1_500;

const WEBUI_SECRET_KEY = "releasebot-fixed-secret";
const ADMIN_NAME = "Admin User";
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = "password";

export class OpenWebUiAdapter implements StackAdapter {
  async install(worktree: string): Promise<void> {
    await runStreaming("npm", ["ci", "--ignore-scripts"], worktree);
    await runStreaming("uv", ["venv", "--python", "3.12"], worktree);
    await runStreaming(
      "uv",
      ["pip", "install", "-r", "backend/requirements.txt"],
      worktree,
    );
    await linkPlaywrightFromReleasebot(worktree);
  }

  async boot(worktree: string, port: number, homeDir: string): Promise<BootedStack> {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.mkdir(homeDir, { recursive: true });
    const logPath = path.join(path.dirname(homeDir), `boot-${port}.log`);
    await fs.writeFile(logPath, "");

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: homeDir,
      WEBUI_SECRET_KEY,
      WEBUI_AUTH: "true",
      ENABLE_INITIAL_ADMIN_SIGNUP: "true",
      CORS_ALLOW_ORIGIN: "*",
      SCARF_NO_ANALYTICS: "true",
      ANONYMIZED_TELEMETRY: "false",
      DO_NOT_TRACK: "true",
      ENABLE_OLLAMA_API: "false",
      ENABLE_OPENAI_API: "false",
      ENABLE_BASE_MODELS_CACHE: "false",
      OFFLINE_MODE: "true",
    };

    await runStreaming("npm", ["run", "build"], worktree, baseEnv, logPath);

    const logStream = createWriteStream(logPath, { flags: "a" });
    await new Promise<void>((resolve) => logStream.once("open", () => resolve()));
    const proc = spawn(
      path.join(worktree, ".venv", "bin", "python"),
      [
        "-m",
        "uvicorn",
        "open_webui.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--workers",
        "1",
      ],
      {
        cwd: path.join(worktree, "backend"),
        env: baseEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );
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
        `open-webui stack at ${baseUrl} failed to become healthy. Last log lines:\n${tail}\n\nOriginal: ${(err as Error).message}`,
      );
    }

    return {
      baseUrl,
      pid: proc.pid,
      shutdown: async () => {
        await shutdownProc(proc);
      },
    };
  }

  async provideAuth(baseUrl: string, artifactsDir: string, sideLabel: Side): Promise<AuthContext | undefined> {
    const sideDir = path.join(artifactsDir, sideLabel);
    await fs.mkdir(sideDir, { recursive: true });
    const storageStatePath = path.join(sideDir, "storageState.json");

    const signupRes = await fetch(`${baseUrl}/api/v1/auths/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (signupRes.status !== 200 && signupRes.status !== 400 && signupRes.status !== 403) {
      throw new Error(`POST /api/v1/auths/signup returned ${signupRes.status}: ${await signupRes.text()}`);
    }

    const signinRes = await fetch(`${baseUrl}/api/v1/auths/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (signinRes.status !== 200) {
      throw new Error(`POST /api/v1/auths/signin returned ${signinRes.status}: ${await signinRes.text()}`);
    }
    const { token } = (await signinRes.json()) as { token: string };

    const settingsRes = await fetch(`${baseUrl}/api/v1/users/user/settings/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ui: { showChangelog: false, showUpdateToast: false } }),
    });
    if (settingsRes.status !== 200) {
      throw new Error(`settings/update returned ${settingsRes.status}: ${await settingsRes.text()}`);
    }

    const seededChatId = await seedChatWithCitations(baseUrl, token);

    const origin = new URL(baseUrl).origin;
    const storageState = {
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            { name: "token", value: token },
            { name: "locale", value: "en-US" },
            { name: "version", value: "releasebot" },
            { name: "sidebar", value: "true" },
            {
              name: "settings",
              value: JSON.stringify({ showChangelog: false, showUpdateToast: false }),
            },
          ],
        },
      ],
    };
    await fs.writeFile(storageStatePath, JSON.stringify(storageState));

    return {
      storageStatePath,
      description:
        `logged in as ${ADMIN_EMAIL} (open-webui seeded admin). ` +
        `A pre-seeded chat titled exactly "Releasebot citations seed" exists in the left sidebar — its assistant message contains 4 web-style sources. ` +
        `Sidebar is open by default. To exercise Citations.svelte, navigate to "/" and click the sidebar chat entry. ` +
        `That entry is an <a> (role=link) element matched by \`page.getByRole("link", { name: /Releasebot citations seed/ })\` — use that exact selector. ` +
        `Do NOT navigate by chat ID; IDs differ between the before and after stacks. ` +
        `Once the chat opens, locate the Sources toggle button via \`page.locator('button[aria-label^="Toggle "][aria-label$=" sources"]')\` (its aria-label is "Toggle 4 sources" — lowercase 'sources'); the visible text "4 Sources" lives in a child div. ` +
        `The +N overflow badge is the only div[aria-hidden="true"] inside that button — match it with \`page.locator('button[aria-label*="sources"] div[aria-hidden="true"]')\` and assert toHaveText(/^\\+\\d+$/) — the seeded chat should produce "+1". ` +
        `Seeded chat ID on this side (for reference only): ${seededChatId}.`,
    };
  }
}

const SEEDED_CHAT_TITLE = "Releasebot citations seed";

async function seedChatWithCitations(baseUrl: string, token: string): Promise<string> {
  const existing = await fetch(`${baseUrl}/api/v1/chats/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (existing.status === 200) {
    const chats = (await existing.json()) as Array<{ id: string; title: string }>;
    const match = chats.find((c) => c.title === SEEDED_CHAT_TITLE);
    if (match) return match.id;
  }

  const sources = [1, 2, 3, 4].map((n) => ({
    source: { name: `Releasebot Source ${n}`, url: `https://example.com/releasebot/${n}` },
    document: [`Releasebot seeded citation document ${n}.`],
    metadata: [{ source: `https://example.com/releasebot/${n}`, name: `Releasebot Source ${n}` }],
    distances: [0.1 * n],
  }));
  const userId = "rb-user-1";
  const messageId = "rb-msg-1";
  const ts = Math.floor(Date.now() / 1000);
  const userMsg = {
    id: userId,
    parentId: null as string | null,
    childrenIds: [messageId],
    role: "user",
    content: "Tell me about the releasebot test sources.",
    timestamp: ts,
    models: ["releasebot-stub"],
  };
  const assistantMsg = {
    id: messageId,
    parentId: userId,
    childrenIds: [] as string[],
    role: "assistant",
    content: "Here is a seeded answer with four citations: [1], [2], [3], [4].",
    sources,
    timestamp: ts,
    done: true,
    model: "releasebot-stub",
    modelName: "Releasebot Stub",
  };
  const chat = {
    title: "Releasebot citations seed",
    models: ["releasebot-stub"],
    messages: [userMsg, assistantMsg],
    history: {
      messages: { [userId]: userMsg, [messageId]: assistantMsg },
      currentId: messageId,
    },
    tags: [],
  };
  const importRes = await fetch(`${baseUrl}/api/v1/chats/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      chats: [{ chat, folder_id: null, meta: {}, pinned: false }],
    }),
  });
  if (importRes.status === 200) {
    const created = (await importRes.json()) as Array<{ id: string }>;
    if (created.length > 0) return created[0].id;
  }
  const res = await fetch(`${baseUrl}/api/v1/chats/new`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ chat, folder_id: null }),
  });
  if (res.status !== 200) {
    throw new Error(`chats/new returned ${res.status}: ${await res.text()}`);
  }
  const created = (await res.json()) as { id: string };
  return created.id;
}

async function linkPlaywrightFromReleasebot(worktree: string): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const releasebotNm = path.resolve(here, "..", "..", "node_modules");
  const repoRoot = path.resolve(worktree, "..", "..", "..", "..");
  for (const targetNm of [path.join(worktree, "node_modules"), path.join(repoRoot, "node_modules")]) {
    await fs.mkdir(path.join(targetNm, "@playwright"), { recursive: true });
    for (const [from, to] of [
      [path.join(releasebotNm, "@playwright", "test"), path.join(targetNm, "@playwright", "test")],
      [path.join(releasebotNm, "playwright"), path.join(targetNm, "playwright")],
      [path.join(releasebotNm, "playwright-core"), path.join(targetNm, "playwright-core")],
    ]) {
      await fs.rm(to, { recursive: true, force: true });
      await fs.symlink(from, to, "dir");
    }
  }
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
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: boolean };
        if (body.status === true) return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${baseUrl}/health`);
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
