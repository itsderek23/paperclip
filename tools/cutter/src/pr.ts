import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { PrMeta } from "./types.ts";

const execFile = promisify(execFileCb);

export async function fetchPrMeta(prNumber: number): Promise<PrMeta> {
  const { stdout } = await execFile("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "baseRefOid,headRefOid,number,title,body,url",
  ]);
  const raw = JSON.parse(stdout) as {
    baseRefOid: string;
    headRefOid: string;
    number: number;
    title: string;
    body: string | null;
    url: string;
  };
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    url: raw.url,
    baseSha: raw.baseRefOid,
    headSha: raw.headRefOid,
  };
}

export async function fetchPrDiff(prNumber: number): Promise<string> {
  const { stdout } = await execFile("gh", ["pr", "diff", String(prNumber)], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export interface PrCiSummary {
  mergeable: string;
  failingChecks: { name: string; detailsUrl: string }[];
}

export async function fetchPrCiSummary(prNumber: number): Promise<PrCiSummary> {
  const { stdout } = await execFile("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "mergeable,statusCheckRollup",
  ]);
  const raw = JSON.parse(stdout) as {
    mergeable: string;
    statusCheckRollup: { name?: string; conclusion?: string | null; detailsUrl?: string }[];
  };
  const failingChecks = (raw.statusCheckRollup ?? [])
    .filter((c) => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT" || c.conclusion === "CANCELLED")
    .map((c) => ({ name: c.name ?? "unknown", detailsUrl: c.detailsUrl ?? "" }));
  return { mergeable: raw.mergeable, failingChecks };
}

export async function ensureShaReachable(sha: string, prNumber: number): Promise<void> {
  try {
    await execFile("git", ["cat-file", "-e", sha]);
    return;
  } catch {
    // not local yet
  }
  try {
    await execFile("git", ["fetch", "origin", `pull/${prNumber}/head`]);
    await execFile("git", ["cat-file", "-e", sha]);
    return;
  } catch {
    // pull/<n>/head covers the head commit and its ancestors, but not a base SHA
    // on origin/<baseBranch> that has moved since the last fetch. Fall through.
  }
  await execFile("git", ["fetch", "origin", sha]);
}
