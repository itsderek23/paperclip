import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import type { Plan, PrMeta, RunReview, SideResult, StepReview } from "./types.ts";

const MODEL = "claude-opus-4-7";

const STEP_SYSTEM = `You are a QA reviewer looking at two screenshots of the same browser step — one rendered against the PR base ("before") and one against the PR head ("after").

Given the step's description, the Playwright test source that produced it, and the plan rationale tying it to the diff, decide whether the rendering change from before -> after looks correct for this PR.

Reply with strict JSON:
{ "verdict": "pass" | "fail" | "intentional_change",
  "observation": "<one sentence describing what you see changed or didn't>",
  "expected": "<only if verdict=fail, one sentence describing what correct would look like>" }

Use "pass" when before and after look identical / unchanged for this surface.
Use "intentional_change" when the after clearly reflects the PR's intent and looks correct.
Use "fail" when the after shows a clipped, broken, misaligned, missing, or wrong-state render that a human reviewer would block the PR for.

Consider the Playwright test source when judging — if the test clicked a menu trigger, both screenshots should reflect the open-menu state; a closed menu after the click would be a test-harness problem, not a PR regression.

Return ONLY the JSON. No markdown fences.`;

const SUMMARY_SYSTEM = `Write a <=400-character single-paragraph run summary for a human reviewer opening the comparison page.

The visual review (per-step verdicts: pass/intentional_change/fail) is the source of truth for whether this PR ships cleanly. Anchor the summary on those verdicts.

The Playwright assertion layer is a secondary signal. The user message gives you exact pass/fail counts for each side as "Facts". Treat those numbers as ground truth — do NOT invert, embellish, or restate them inaccurately. If "after_fails" is 0, the after side did not fail. Before-side assertion failures are EXPECTED when the test asserts on copy the PR introduced — do not flag them as regressions.

After-side assertion failures are worth mentioning only if the visual review also flagged the step as fail.

Start with the headline outcome (how many steps passed / were intentional_change / failed per the visual review), then what the visual review actually observed, then any caveat worth a reviewer's attention. Natural user-facing language — no code identifiers, no bulleted lists. End on a complete sentence. Return plain text only.`;

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
    if (!beforePng || !afterPng) {
      stepReviews.push({
        step_n: stepN,
        verdict: "fail",
        observation: "Missing before or after screenshot.",
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
  const visualCounts = {
    pass: steps.filter((s) => s.verdict === "pass").length,
    intentional_change: steps.filter((s) => s.verdict === "intentional_change").length,
    fail: steps.filter((s) => s.verdict === "fail").length,
  };
  const content = [
    `PR #${pr.number}: ${pr.title}`,
    `Body: ${pr.body.slice(0, 600)}`,
    "Facts (ground truth — quote these numbers, do not invert):",
    `  total_steps: ${steps.length}`,
    `  visual_review: ${visualCounts.pass} pass, ${visualCounts.intentional_change} intentional_change, ${visualCounts.fail} fail`,
    `  before_fails: ${beforeFails}/${before.steps.length} (expected — PR introduces new copy/routes)`,
    `  after_fails: ${afterFails}/${after.steps.length}`,
    `Per-step visual review detail: ${JSON.stringify(steps)}`,
  ].join("\n");
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content }],
  });
  const raw = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join(" ")
    .trim();
  return softTruncate(raw, 600);
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
