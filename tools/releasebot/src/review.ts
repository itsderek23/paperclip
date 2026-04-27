import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import type { Plan, PrMeta, RunReview, SideResult, StepReview } from "./types.ts";

const MODEL = "claude-opus-4-7";

const STEP_SYSTEM = `You are a QA reviewer looking at two screenshots of the same browser step — one rendered against the PR base ("before") and one against the PR head ("after").

Given the step's description, the Playwright test source that produced it, and the plan rationale tying it to the diff, decide whether the rendering change from before -> after looks correct for this PR.

Reply with strict JSON:
{ "verdict": "pass" | "fail" | "intentional_change",
  "observation": "<one sentence describing what you see changed or didn't>",
  "expected": "<only if verdict=fail, one sentence describing what correct would look like>",
  "pageKind": "<2-4 word noun phrase naming the page or surface, in app-agnostic plain English. Examples: 'Issue detail page', 'Project board', 'Agent settings — overview tab', 'Sign-in page'. Use the screenshot and URL together to name what page this is. If the page is unrecognizable (error page, 404, blank state), return 'Unknown page'.>" }

Use "pass" when before and after look identical / unchanged for this surface.
Use "intentional_change" when the after clearly reflects the PR's intent and looks correct.
Use "fail" when the after shows a clipped, broken, misaligned, missing, or wrong-state render that a human reviewer would block the PR for.

Consider the Playwright test source when judging — if the test clicked a menu trigger, both screenshots should reflect the open-menu state; a closed menu after the click would be a test-harness problem, not a PR regression.

Return ONLY the JSON. No markdown fences.`;

const SUMMARY_SYSTEM = `Write 1-3 sentences of narrative prose describing what the visual review actually observed across the PR's captured screenshots, for a human reviewer.

The caller prepends a deterministic counts line to your output — DO NOT restate, cite, or embellish totals (no "3/3", "all three", "both sides", "after-side failures", etc). Your job is the narrative tail only: what changed on the page and whether it looks right.

If the run has any inconclusive verdicts (Playwright step failed so the screenshots aren't of the surface-under-test), lead with that caveat in plain user-facing language — e.g. "The planned flow didn't reach the page it was meant to exercise, so these screenshots can't tell us whether the PR works." Do not pretend those steps are a pass.

Rules:
- No code identifiers (method names, class names, file paths, CSS selectors, attribute names).
- No bulleted lists, no step-by-step enumeration.
- Natural user-facing language describing what a viewer would see.
- End on a complete sentence.
- Return plain text only. No markdown, no quotes, no headers.`;

export async function reviewRun(
  pr: PrMeta,
  plan: Plan,
  before: SideResult,
  after: SideResult,
  options: { apiKey: string },
): Promise<RunReview> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const perStepSource = extractPerStepTestSource(plan.spec);
  const stepReviews: StepReview[] = [];

  for (const [idx, step] of plan.metadata.steps.entries()) {
    const stepN = idx + 1;
    const beforePng = before.steps[idx]?.screenshot;
    const afterPng = after.steps[idx]?.screenshot;
    const beforeStatus = before.steps[idx]?.status;
    const afterStatus = after.steps[idx]?.status;
    if (!beforePng || !afterPng) {
      stepReviews.push({
        step_n: stepN,
        verdict: "fail",
        observation: "Missing before or after screenshot.",
      });
      continue;
    }
    if (beforeStatus === "fail" && afterStatus === "fail") {
      stepReviews.push({
        step_n: stepN,
        verdict: "inconclusive",
        observation:
          "Playwright step failed on both sides, so the screenshots show an error/default state rather than the surface-under-test. Cannot judge the PR from these captures — likely a hallucinated selector or a plan that doesn't match the actual UI.",
      });
      continue;
    }
    try {
      const [beforeB64, afterB64] = await Promise.all([readPngBase64(beforePng), readPngBase64(afterPng)]);
      const testSource = perStepSource.get(stepN) ?? "(test source not isolatable — see spec file)";
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: STEP_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  `PR #${pr.number}: ${pr.title}`,
                  `Step ${stepN}: ${step.description}`,
                  `URL: ${step.url}`,
                  `Plan rationale: ${plan.metadata.rationale}`,
                  "",
                  "Playwright test source for this step:",
                  "```ts",
                  testSource,
                  "```",
                  "",
                  "Before (PR base):",
                ].join("\n"),
              },
              { type: "image", source: { type: "base64", media_type: "image/png", data: beforeB64 } },
              { type: "text", text: "After (PR head):" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: afterB64 } },
            ],
          },
        ],
      });
      const text = resp.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n");
      stepReviews.push(parseStepReview(text, stepN));
    } catch (err) {
      stepReviews.push({
        step_n: stepN,
        verdict: "fail",
        observation: `Visual review errored: ${(err as Error).message}`,
      });
    }
  }

  const summary = await summarize(client, pr, stepReviews, before, after);
  return { summary, steps: stepReviews };
}

/**
 * Parse the spec body into a map of stepNumber -> test source. Uses the
 * `step-NN` prefix in each test title. Robust to nested braces via balance count.
 */
function extractPerStepTestSource(spec: string): Map<number, string> {
  const out = new Map<number, string>();
  // Match `test(<quote>step-NN` then scan forward to the first `{` that begins the callback.
  const re = /test\(\s*["'`]step-(\d+)\b[\s\S]*?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spec)) !== null) {
    const stepN = Number(m[1]);
    const start = m.index;
    const bodyStart = re.lastIndex - 1; // points at the `{`
    // Balanced-brace scan to find the matching `}` that closes the test callback.
    let depth = 0;
    let end = bodyStart;
    for (let i = bodyStart; i < spec.length; i++) {
      const c = spec[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    // Also capture the trailing `);` so the snippet is a complete `test(...)`.
    const tail = spec.slice(end).match(/^\s*\)\s*;?/);
    const snippetEnd = end + (tail ? tail[0].length : 0);
    out.set(stepN, spec.slice(start, snippetEnd));
  }
  return out;
}

async function summarize(
  client: Anthropic,
  pr: PrMeta,
  steps: StepReview[],
  before: SideResult,
  after: SideResult,
): Promise<string> {
  const beforeFails = before.steps.filter((s) => s.status === "fail").length;
  const afterFails = after.steps.filter((s) => s.status === "fail").length;
  const beforePasses = before.steps.length - beforeFails;
  const afterPasses = after.steps.length - afterFails;
  const visualCounts = {
    pass: steps.filter((s) => s.verdict === "pass").length,
    intentional_change: steps.filter((s) => s.verdict === "intentional_change").length,
    fail: steps.filter((s) => s.verdict === "fail").length,
    inconclusive: steps.filter((s) => s.verdict === "inconclusive").length,
  };
  const visualBits: string[] = [];
  if (visualCounts.intentional_change) visualBits.push(`${visualCounts.intentional_change} intentional change`);
  if (visualCounts.pass) visualBits.push(`${visualCounts.pass} unchanged`);
  if (visualCounts.fail) visualBits.push(`${visualCounts.fail} visual fail`);
  if (visualCounts.inconclusive) visualBits.push(`${visualCounts.inconclusive} inconclusive`);
  const deterministicPrefix =
    `${steps.length} step${steps.length === 1 ? "" : "s"}: ` +
    (visualBits.length > 0 ? visualBits.join(", ") : "no verdicts") +
    `. Playwright: ${beforePasses}/${before.steps.length} passed before, ${afterPasses}/${after.steps.length} passed after.`;

  const content = [
    `PR #${pr.number}: ${pr.title}`,
    `Body: ${pr.body.slice(0, 600)}`,
    "",
    "Per-step visual review detail (what to narrate):",
    JSON.stringify(steps, null, 2),
    "",
    `Counts prefix already written for you (do NOT restate): "${deterministicPrefix}"`,
  ].join("\n");
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content }],
  });
  const narrative = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join(" ")
    .trim();
  return softTruncate(`${deterministicPrefix} ${narrative}`, 600);
}

function softTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  // Prefer the last sentence-ending punctuation within the window.
  const lastPeriod = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (lastPeriod > max * 0.6) return head.slice(0, lastPeriod + 1).trimEnd();
  // Otherwise fall back to the last word boundary.
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > max * 0.8) return head.slice(0, lastSpace).trimEnd() + "…";
  return head.trimEnd() + "…";
}

function parseStepReview(text: string, stepN: number): StepReview {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const json = firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : trimmed;
  try {
    const parsed = JSON.parse(json) as Omit<StepReview, "step_n">;
    return { step_n: stepN, ...parsed };
  } catch {
    return { step_n: stepN, verdict: "fail", observation: `Failed to parse review JSON: ${text.slice(0, 200)}` };
  }
}

async function readPngBase64(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return buf.toString("base64");
}
