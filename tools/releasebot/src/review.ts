import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import type { Plan, PrMeta, RunReview, SideResult, StepReview } from "./types.ts";

const MODEL = "claude-opus-4-7";

const STEP_SYSTEM = `You are a QA reviewer looking at two screenshots of the same browser step — one rendered against the PR base ("before") and one against the PR head ("after").

Given the step's description, its assert_contains substring, the diff hunks the plan rationale tied to it, decide whether the rendering change from before -> after looks correct for this PR.

Reply with strict JSON:
{ "verdict": "pass" | "fail" | "intentional_change",
  "observation": "<one sentence describing what you see changed or didn't>",
  "expected": "<only if verdict=fail, one sentence describing what correct would look like>" }

Use "pass" when before and after look identical / unchanged for this surface.
Use "intentional_change" when the after clearly reflects the PR's intent and looks correct.
Use "fail" when the after shows a clipped, broken, misaligned, missing, or wrong-state render that a human reviewer would block the PR for.

Return ONLY the JSON. No markdown fences.`;

const SUMMARY_SYSTEM = `Write a <=400-character single-paragraph run summary for a human reviewer opening the comparison page.

The visual review (per-step verdicts: pass/intentional_change/fail) is the source of truth for whether this PR ships cleanly. Anchor the summary on those verdicts.

The assertion layer (text substring checks) is a coarse safety net, and its failures on the BEFORE side are EXPECTED and not regressions — the plan intentionally asserts on copy the PR introduced, so that copy will be missing on base. Do not flag before-side assertion failures. After-side assertion failures ARE worth mentioning as a secondary signal, but only if the visual review also flagged the step as fail.

Start with the headline outcome (how many steps passed / were intentional_change / failed per the visual review), then what the visual review actually observed, then any caveat worth a reviewer's attention. Natural user-facing language — no code identifiers, no bulleted lists. Return plain text only.`;

export async function reviewRun(
  pr: PrMeta,
  plan: Plan,
  before: SideResult,
  after: SideResult,
  options: { apiKey: string },
): Promise<RunReview> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const stepReviews: StepReview[] = [];
  for (const [idx, step] of plan.steps.entries()) {
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
                  `assert_contains: ${JSON.stringify(step.assert_contains)}`,
                  `annotated selectors: ${JSON.stringify(step.annotate ?? [])}`,
                  `Plan rationale: ${plan.rationale}`,
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

async function summarize(
  client: Anthropic,
  pr: PrMeta,
  steps: StepReview[],
  before: SideResult,
  after: SideResult,
): Promise<string> {
  const afterFails = after.steps.filter((s) => s.status === "fail").length;
  const content = [
    `PR #${pr.number}: ${pr.title}`,
    `Body: ${pr.body.slice(0, 600)}`,
    `Step-level visual review (source of truth): ${JSON.stringify(steps)}`,
    `Assertion failures on after side (secondary signal): ${afterFails}/${after.steps.length}`,
    // Deliberately omitting before-side assertion counts — they're expected when the
    // plan asserts on diff-introduced copy, and including them invites false alarms.
  ].join("\n\n");
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user", content }],
  });
  return resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join(" ")
    .trim()
    .slice(0, 600);
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
