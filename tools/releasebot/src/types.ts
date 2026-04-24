export interface PrMeta {
  number: number;
  title: string;
  body: string;
  url: string;
  baseSha: string;
  headSha: string;
}

export interface PlanStep {
  description: string;
  url: string;
  assert_contains: string;
  annotate?: string[];
  full_page?: boolean;
}

export interface Plan {
  title: string;
  goal: string;
  rationale: string;
  steps: PlanStep[];
}

export type Side = "before" | "after";

export interface StepResult {
  step_n: number;
  status: "pass" | "fail";
  error?: string;
  screenshot: string;
}

export interface SideResult {
  side: Side;
  baseUrl: string;
  steps: StepResult[];
}

export type Verdict = "pass" | "fail" | "intentional_change";

export interface StepReview {
  step_n: number;
  verdict: Verdict;
  observation: string;
  expected?: string;
}

export interface RunReview {
  summary: string;
  steps: StepReview[];
}

export interface FixtureSpecEntity {
  name: string;
  endpoint: string;
  body: Record<string, unknown>;
  capture?: Record<string, string>;
}

export interface FixtureSpec {
  rationale: string;
  entities: FixtureSpecEntity[];
}

export interface FixtureSummaryEntry {
  values: Record<string, string>;
  note?: string;
}

export type FixtureSummary = Record<string, FixtureSummaryEntry>;
