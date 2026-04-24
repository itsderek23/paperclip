export interface PrMeta {
  number: number;
  title: string;
  body: string;
  url: string;
  baseSha: string;
  headSha: string;
}

export interface PlanStepMetadata {
  description: string;
  url: string;
}

export interface PlanMetadata {
  title: string;
  goal: string;
  rationale: string;
  steps: PlanStepMetadata[];
}

export interface Plan {
  metadata: PlanMetadata;
  /** Body of the generated Playwright spec: one `test(...)` per step, in order.
   * We wrap this with imports + describe boilerplate at write time. */
  spec: string;
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

export type Verdict = "pass" | "fail" | "intentional_change" | "inconclusive";

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

export interface AuthContext {
  storageStatePath: string;
  description: string;
}
