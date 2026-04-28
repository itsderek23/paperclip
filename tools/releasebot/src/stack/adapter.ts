import type { AuthContext, FixtureSpec, FixtureSummary, Side } from "../types.ts";

export interface BootedStack {
  baseUrl: string;
  shutdown(): Promise<void>;
  pid?: number;
}

export interface StackAdapter {
  install(worktree: string): Promise<void>;
  boot(worktree: string, port: number, homeDir: string): Promise<BootedStack>;
  seed?(
    baseUrl: string,
    spec: FixtureSpec,
    artifactsDir: string,
    sideLabel: string,
    initialSummary?: FixtureSummary,
  ): Promise<FixtureSummary>;
  provideAuth?(baseUrl: string, artifactsDir: string, sideLabel: Side): Promise<AuthContext | undefined>;
  promptHints?(): Promise<string>;
}
