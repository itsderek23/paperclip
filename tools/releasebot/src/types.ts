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
  /** Set by the planner when the diff's visible UI is gated on runtime state,
   * live data, or anything the test environment can't synthesize (e.g. a
   * scheduled retry, a live in-progress run, a real third-party callback).
   * One sentence explaining what we couldn't produce. Surfaced as a callout in
   * the cutter comment so reviewers know "screenshots match" doesn't mean
   * "we exercised the change". */
  coverageNote?: string | null;
}

export interface Plan {
  metadata: PlanMetadata;
  /** Body of the generated Playwright spec: one `test(...)` per step, in order.
   * We wrap this with imports + describe boilerplate at write time. */
  spec: string;
}

export type Side = "before" | "after";

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StepResult {
  step_n: number;
  status: "pass" | "fail" | "inconclusive";
  error?: string;
  screenshot: string;
  /** Union rect per selector index, in page (CSS) pixel coordinates. Captured
   * at run time by the spec's afterEach hook from `annotate()`'s return value.
   * Absent when the test had no markAnnotations() call or when no selector
   * resolved. Used by the report to crop focus-mode images. */
  bboxes?: BBox[];
  /** Set when the after-side spec was rewritten from rendered DOM and re-run.
   * Carries enough context for the report to show what failed first and what
   * we ran instead. */
  repair?: StepRepairRecord;
}

export interface StepRepairRecord {
  /** "applied" — repair LLM produced a revised test body and the rerun executed.
   *  "skipped_shape_b" — failure looked like a fixture-coverage gap (affordance
   *  text not in DOM), so we did NOT repair; step status downgraded to inconclusive.
   *  "failed" — repair LLM threw or returned unparseable output.
   *  "seed_extended" — Shape B detected; new fixture entities were synthesized
   *  and applied, then the step (and optionally a follow-up DOM-grounded rewrite)
   *  recovered the failure.
   *  "seed_extension_failed" — Shape B detected; seed extension was attempted
   *  but either the LLM declined (CANNOT_EXTEND), apply failed, or the post-extension
   *  rerun still didn't pass.
   *  "url_rewritten" — triage chose rewrite_url; we substituted the goto URL
   *  and re-ran. status pass/fail reflects the rerun.
   *  "triage_give_up" — triage diagnosed the failure as un-repairable (real
   *  regression, contradictory evidence, or unsynthesizable affordance). */
  outcome:
    | "applied"
    | "skipped_shape_b"
    | "failed"
    | "seed_extended"
    | "seed_extension_failed"
    | "url_rewritten"
    | "triage_give_up";
  reason: string;
  originalError: string;
  originalTestBody?: string;
  revisedTestBody?: string;
  /** Path (relative to artifacts dir) of the saved pre-repair screenshot, if we
   * snapshotted one. Only present when outcome === "applied" or "seed_extended". */
  originalScreenshot?: string;
  /** Names of fixture entities the LLM synthesized and successfully POSTed.
   * Only present when seed extension was attempted. */
  addedEntities?: string[];
  /** One-line rationale from the seed-revision LLM explaining what data shape
   * was added and why. Only present when seed extension was attempted. */
  seedExtensionRationale?: string;
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
  pageKind?: string;
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

export type TriageAction =
  | { kind: "rewrite_locator"; reason: string }
  | { kind: "rewrite_url"; reason: string; suggestedUrl: string }
  | { kind: "extend_seed"; reason: string }
  | { kind: "give_up"; reason: string };
