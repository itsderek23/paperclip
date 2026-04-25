import type { AuthContext, FixtureSpec, FixtureSummary, Side } from "../types.ts";

export interface BootedStack {
  baseUrl: string;
  shutdown(): Promise<void>;
  pid?: number;
}

export interface SeedContext {
  diff: string;
  worktreePath: string;
  apiKey: string;
  artifactsDir: string;
}

export interface StackAdapter {
  install(worktree: string): Promise<void>;
  boot(worktree: string, port: number, homeDir: string): Promise<BootedStack>;
  buildSeedSpec?(ctx: SeedContext): Promise<FixtureSpec>;
  seed?(baseUrl: string, spec: FixtureSpec, artifactsDir: string, sideLabel: string): Promise<FixtureSummary>;
  provideAuth?(baseUrl: string, artifactsDir: string, sideLabel: Side): Promise<AuthContext | undefined>;
}
