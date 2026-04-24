import Anthropic from "@anthropic-ai/sdk";
import type { FixtureSummary, Plan, PrMeta } from "./types.ts";

const MODEL = "claude-opus-4-7";
const MAX_DIFF_CHARS = 180_000;

const SYSTEM_PROMPT = `You are writing a throwaway browser-QA plan for a single GitHub PR against a Paperclip webapp.

Output strict JSON matching this TypeScript schema:

type Plan = {
  title: string;          // <=60 chars, feature/scenario name
  goal: string;           // 1 sentence QA-spec prose
  rationale: string;      // 2-4 sentences tying each step to the diff
  steps: PlanStep[];      // 2 to 6 steps
};
type PlanStep = {
  description: string;    // <=90 chars, what this step does in reviewer prose
  url: string;            // RELATIVE path, starts with "/"
  assert_contains: string;// substring that must appear on the rendered page, SPECIFIC to the diff
  annotate?: string[];    // 1-4 CSS selectors to outline in the screenshot; pick nodes the diff introduced/modified
  full_page?: boolean;    // default false
};

Rules:
- Every step MUST have a non-empty \`assert_contains\`. Pick a diff-specific string (new copy, a new data-* attribute literal, a new component name) — never something that also appears on a login/empty/404 page.
- Prefer relative URLs that map to routes under the SPA (Paperclip routes include /issues, /inbox, /agents, /companies, /approvals, etc.).
- \`annotate\` selectors should target DOM nodes the diff adds or modifies. Use stable selectors: data-testid, role, or classes from the diff.
- No external URLs. No auth flows. The stack boots in local_trusted mode with no sign-in required.
- Return ONLY the JSON object. No markdown fences, no commentary.`;

export async function generatePlan(
  pr: PrMeta,
  diff: string,
  options: { apiKey: string; fixtures?: FixtureSummary },
): Promise<Plan> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const truncatedDiff = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n... (diff truncated)" : diff;
  const fixturesBlock = options.fixtures ? renderFixtures(options.fixtures) : "";
  const userContent = [
    `PR #${pr.number}: ${pr.title}`,
    `URL: ${pr.url}`,
    "",
    "Body:",
    pr.body || "(empty)",
    "",
    ...(fixturesBlock ? ["Seeded fixtures available in both environments (use these exact values in step URLs):", fixturesBlock, ""] : []),
    "Unified diff:",
    "```diff",
    truncatedDiff,
    "```",
  ].join("\n");

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });
  const text = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  const json = extractJson(text);
  const plan = JSON.parse(json) as Plan;
  validatePlan(plan);
  return plan;
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text;
}

function renderFixtures(summary: FixtureSummary): string {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(summary)) {
    // Skip failed fixtures — listing them invites the planner to hallucinate URLs.
    if (Object.keys(entry.values).length === 0) continue;
    const fields = Object.entries(entry.values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    lines.push(`- ${name}: ${fields}`);
  }
  if (lines.length === 0) return "";
  lines.push("");
  lines.push(
    "When a step needs an issue URL, use /issues/<identifier> with an identifier captured above. If no suitable fixture exists, write a step that exercises a list/index surface instead — DO NOT invent an ID or use a company id as an issue id.",
  );
  return lines.join("\n");
}

function validatePlan(plan: Plan): void {
  if (!plan.steps?.length) throw new Error("Plan has no steps");
  for (const [i, step] of plan.steps.entries()) {
    if (!step.url?.startsWith("/")) throw new Error(`Step ${i + 1} url must be relative`);
    if (!step.assert_contains) throw new Error(`Step ${i + 1} missing assert_contains`);
  }
}
