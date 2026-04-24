import type { FixtureSpec, FixtureSummary } from "../types.ts";

export interface BootedStack {
  baseUrl: string;
  shutdown(): Promise<void>;
}

export interface SeedContext {
  diff: string;
  worktreePath: string;
  apiKey: string;
  artifactsDir: string;
}

export interface StackAdapter {
  boot(worktree: string, port: number, homeDir: string): Promise<BootedStack>;
  buildSeedSpec?(ctx: SeedContext): Promise<FixtureSpec>;
  seed?(baseUrl: string, spec: FixtureSpec, artifactsDir: string, sideLabel: string): Promise<FixtureSummary>;
}
