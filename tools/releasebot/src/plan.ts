import Anthropic from "@anthropic-ai/sdk";
import type { AuthContext, FixtureSummary, Plan, PlanMetadata, PlanStepMetadata, PrMeta } from "./types.ts";

const MODEL = "claude-opus-4-7";
const MAX_DIFF_CHARS = 180_000;

const SYSTEM_PROMPT = `You are writing a throwaway browser-QA plan for a single GitHub PR against a Paperclip webapp.

You produce two things in a single JSON object: structured metadata + the body of a Playwright test spec.

Output schema (strict, return ONLY this JSON object — no markdown fences, no commentary):

{
  "metadata": {
    "title": string,                         // <=60 chars, feature/scenario name
    "goal": string,                          // 1 sentence QA-spec prose
    "rationale": string,                     // 2-4 sentences tying each step to the diff
    "steps": [
      { "description": string, "url": string }   // one entry per test() in the spec, in order
    ],
    "coverageNote": string | null,           // see "Coverage gates" rule below
    "surface": "ui" | "none"                 // see "Surface declaration" rule below; default "ui". When "none", set steps: [] and spec: ""
  },
  "spec": string                             // the TypeScript body: one test(...) per step. Set to "" when surface is "none"
}

The spec body is injected into a file that already has these imports and hooks in scope:

    import { test, expect } from "@playwright/test";
    import { markAnnotations } from "<absolute path>";
    const SCREENSHOT_DIR = process.env.RELEASEBOT_SCREENSHOT_DIR ?? ".";

    // An afterEach hook is auto-injected that:
    //   1. reads the selectors registered via markAnnotations(...) at the top of the test,
    //   2. resolves their bounding boxes (used for focus-mode crops in the QA report),
    //   3. takes step-NN.png.
    // All three happen regardless of whether the test body threw — so even a
    // failing expect() still yields a screenshot and bbox sidecar.

Do NOT include imports, SCREENSHOT_DIR, test.afterEach, or test.describe.configure in your spec body — they are provided. Just emit the test(...) calls, in order.

Each test() MUST follow this skeleton:

    test("step-NN · <short description>", async ({ page }) => {
      markAnnotations([/* 1-4 CSS selectors that target the changed region */]);   // FIRST line of the body
      await page.goto("<relative URL>");
      // interactions: locator.click(), .fill(), .hover(), keyboard.press(), etc., as needed
      // assertions: await expect(locator).toBeVisible(); // or .toHaveText, .toHaveAttribute, etc.
      // NO annotate() call. NO page.screenshot — the harness handles both.
    });

markAnnotations() MUST be the FIRST statement in every test body. Calling it up-front means the afterEach hook can still resolve and persist the bboxes even if a subsequent expect() throws, which is exactly what we want for debugging.

Rules:

- Number steps starting at 01. The step number in the test name MUST match step-NN in the screenshot filename and its index (NN-1) in metadata.steps.
- The metadata.steps[].description field is shown to human reviewers in a PR comment. Keep it generic — describe the *kind* of thing being tested, not the specific seeded record. Refer to entities generically ("an issue", "the descendant issue", "a subtask", "the assigned user", "the project"). Do NOT include seeded fixture ids/keys (e.g. "PAP-1", "PAP-6", "REF-2", project codes, user emails) in the description — those are fine in selectors, URLs, and the test name, but not in this user-facing field.
- Coverage gates: the diff's user-visible UI is sometimes gated on runtime state, live data, or anything the test environment can't synthesize — a scheduled retry pending, an in-progress run, a real third-party callback, a long-running animation mid-frame, an actual user with verified email, etc. When you can identify such a gate AND you've deliberately fallen back to a smoke test (e.g. asserting the component still mounts on a real page, instead of asserting the new copy itself), set metadata.coverageNote to one short user-facing sentence explaining what we couldn't produce — generic, no record names. Examples: "The new retry-state badges only render when an issue has a scheduled retry pending, which fixtures can't produce." / "The new in-progress upload UI only appears mid-upload, which the test can't simulate." Otherwise set coverageNote to null. Do NOT use this field for backend-only PRs with no UI surface (just null), and do NOT use it for ordinary PRs whose UI you can fully exercise.
- Reachability before targeting. Before you pick a route to navigate to and a locator to assert on, verify in the source context that BOTH of the following hold: (a) the route's rendered output actually includes the changed component or region — i.e. the diff either adds/modifies the route itself, OR adds/modifies a consumer that mounts the changed component on that route. A component file that is edited but whose imports/mount sites are unchanged in this diff will NOT appear at runtime on routes that previously didn't render it. (b) any conditional or runtime gate around the new copy/region (a non-empty collection, an active session, a feature flag, an in-progress operation, an external callback) is satisfied by the fixtures available — otherwise the new affordance won't render and the assertion will fail regardless of the PR's correctness. When (a) fails, drop the target — do not assert on a component the diff never wires up. When (b) fails and there is no fixture path to satisfy the gate, treat it as a coverage gate (use metadata.coverageNote) instead of asserting on it. Prefer routes that are themselves added or modified in this diff, since their entire rendered output is by definition in-scope.
- Smoke tests must be substantive. A smoke test is acceptable ONLY when you can verify from the source context that the route you target demonstrably mounts the changed component or its consumer chain — i.e. the source context shows the route's component imports the changed file (directly or via a clearly-named consumer) AND the consumer renders unconditionally on first paint for the fixture you're using. Acceptable smoke patterns: (1) "Component mounts on its host route" — assert the changed component's container is visible (not its conditionally-rendered inner content). (2) "Modified or added route smoke" — assert any element from the page's static frame on a route the diff itself adds or modifies. (3) "Renamed/reshaped prop reaches the page" — assert the consumer's container renders on a fixture-seeded page that demonstrably mounts it. (4) "Unconditional new copy" — assert literal new text whose JSX in source context shows no surrounding conditional. Trivial smokes are NOT allowed: never assert generic page chrome (navbar links, app heading, route /) to "prove the app loads." If you cannot establish a mount path from source context for the changed code, do not fall back to a trivial smoke — set metadata.surface = "none" instead (see next rule).
- Surface declaration. Set metadata.surface = "none" (with metadata.steps = [] and spec = "") when, after reading the full source context, you cannot identify ANY substantive smoke pattern from the list above for this diff. Examples that warrant "none": pure backend / CLI / migration / type refactor with no rendered-output change; UI files modified but only in non-rendered code paths (workers, utils, type re-exports); component files modified but the diff doesn't add or modify any consumer that mounts them on a navigable route in the seeded fixtures. When you set "none", metadata.rationale must briefly explain in one sentence why no surface is validatable. Set metadata.surface = "ui" (or omit) and produce 1–6 steps in every other case. Do NOT use this field as an escape hatch for hard-to-test runtime gates — that's what coverageNote is for.
- Use Playwright locators + expect, NOT text-substring includes. Prefer \`page.getByRole("button", { name: "..." })\`, \`page.getByLabel("...")\`, \`page.getByTestId("...")\`, \`page.getByText("...")\`.
- Use ONLY relative URLs on page.goto — baseURL is injected from env.
- For text the PR introduced that is HIDDEN behind an interaction (menu button, tab, drawer, popover, dialog trigger that must be opened to reveal the new content) — click the trigger FIRST, then assert on the new text. If the new content is already visible on initial page load (a new settings section, a new card on a list page, a new banner, new copy in an existing visible region), do NOT add interaction steps; just navigate and assert.
- Prefer the SMALLEST number of steps that covers the diff. If the entire UI change is a single new region or a single piece of new copy on one page, that's ONE step — navigate to the page and assert the new region is visible. Only add more steps when the diff spans multiple distinct pages, multiple distinct interaction flows, or content that genuinely requires interaction to reveal.
- Do NOT split a single static section into one step per child element (one per button, one per row, one per preset). Assert on the section's container or its heading once; the screenshot captures the rest.
- ONLY assert on things the diff actually introduces or modifies. Do NOT add "sanity" assertions on generic page structure (h1 presence, navbar links, etc.) — the diff didn't touch those, they're not a PR signal, and a failing sanity assertion halts the rest of the test. Aim for one assertion per test, the tightest possible to the diff.
- Pick expect targets that are specific to the diff — new copy, new data-* attributes, new component names. Never something that would also appear on a login/404/empty-state screen.
- Annotate selectors (passed to markAnnotations()) should target DOM nodes the diff introduced or modified. Use stable selectors (role, aria-label, data-testid). Every match of each selector is recorded as a bbox — if a selector matches multiple elements (e.g. an aria-label that appears on both an inline ref and a sidebar pill), all matches contribute to a single union region grouped under that selector, which is usually what you want for the focus-mode crop. If you specifically want to point at ONE region, scope the selector: prefix with a container selector like \`aside a[...]\`, \`[data-testid="issue-properties"] a\`, or similar.
- 1 to 6 steps. Each test should be a complete, isolated scenario — no shared state between tests (each gets a fresh page).
- NO page.waitForTimeout, NO arbitrary setTimeout, NO page.evaluate unless genuinely necessary. Rely on Playwright's auto-wait via expect() and locator actions.
- {{AUTH_LINE}}

Keep the spec body clean and human-readable — a reviewer should be able to read it top-to-bottom and understand what was tested.`;

export async function generatePlan(
  pr: PrMeta,
  diff: string,
  options: {
    apiKey: string;
    fixtures?: FixtureSummary;
    sourceContext?: string;
    retryFeedback?: string[];
    authContext?: AuthContext;
  },
): Promise<Plan> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const authLine = options.authContext
    ? `The browser is pre-authenticated — ${options.authContext.description}. Do NOT generate login steps; navigate directly to authenticated routes.`
    : "The stack boots in local_trusted mode with no sign-in — no auth flows needed.";
  const systemPrompt = SYSTEM_PROMPT.replace("{{AUTH_LINE}}", authLine);
  const truncatedDiff = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n... (diff truncated)" : diff;
  const fixturesBlock = options.fixtures ? renderFixtures(options.fixtures) : "";
  const userContent = [
    `PR #${pr.number}: ${pr.title}`,
    `URL: ${pr.url}`,
    "",
    "Body:",
    pr.body || "(empty)",
    "",
    ...(fixturesBlock
      ? [
          "Seeded fixtures available in both environments (use these exact values in step URLs and locators):",
          fixturesBlock,
          "",
        ]
      : []),
    ...(options.sourceContext
      ? [
          "Source context around each diff hunk (post-PR state — use these EXACT aria-label / role-name / data-testid / button text values in your Playwright locators; do NOT guess):",
          "",
          options.sourceContext,
          "",
        ]
      : []),
    ...(options.retryFeedback && options.retryFeedback.length > 0
      ? [
          "Previous attempt used these selectors/literals that do NOT appear in the source context above:",
          ...options.retryFeedback.map((s) => `  - ${s}`),
          "Revise the plan: replace each with a value that is present in the source context, or drop the step entirely. Do not invent UI affordances that aren't in the source.",
          "",
        ]
      : []),
    "Unified diff:",
    "```diff",
    truncatedDiff,
    "```",
  ].join("\n");

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });
  const text = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  const json = extractJson(text);
  const parsed = JSON.parse(json) as { metadata: PlanMetadata; spec: string };
  validate(parsed);
  return { metadata: parsed.metadata, spec: parsed.spec };
}

function extractJson(text: string): string {
  // Reject a narrow ```ts ``` that happens to be the spec body only; prefer an outer ``` block
  // that contains braces.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const m of fences) {
    const inner = m[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text;
}

function renderFixtures(summary: FixtureSummary): string {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(summary)) {
    if (Object.keys(entry.values).length === 0) continue;
    const fields = Object.entries(entry.values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    const suffix = entry.note ? ` — ${entry.note}` : "";
    lines.push(`- ${name}: ${fields}${suffix}`);
  }
  if (lines.length === 0) return "";
  lines.push("");
  lines.push(
    "When a step needs an issue URL, use /issues/<identifier> with an identifier captured above. If no suitable fixture exists, target a list/index surface instead — DO NOT invent an ID or use a company id as an issue id.",
  );
  return lines.join("\n");
}

function validate(p: { metadata: PlanMetadata; spec: string }): void {
  if (!p.metadata) throw new Error("Plan missing metadata");
  if (!Array.isArray(p.metadata.steps)) throw new Error("Plan metadata.steps must be an array");
  if (p.metadata.surface === "none") {
    if (p.metadata.steps.length !== 0) {
      throw new Error('Plan declared surface: "none" but metadata.steps is non-empty');
    }
    if (!p.metadata.rationale || p.metadata.rationale.trim().length === 0) {
      throw new Error('Plan declared surface: "none" but rationale is empty');
    }
    return;
  }
  if (p.metadata.steps.length === 0) {
    throw new Error("Plan metadata has no steps");
  }
  for (const [i, step] of p.metadata.steps.entries()) {
    if (!step.url?.startsWith("/")) throw new Error(`Step ${i + 1} url must be relative`);
    if (!step.description) throw new Error(`Step ${i + 1} missing description`);
  }
  if (typeof p.spec !== "string" || p.spec.trim().length === 0) {
    throw new Error("Plan spec body is empty");
  }
  const testCount = (p.spec.match(/\btest\(/g) ?? []).length;
  if (testCount === 0) throw new Error("Plan spec contains no test(...) calls");
  if (testCount !== p.metadata.steps.length) {
    throw new Error(
      `Plan spec has ${testCount} test(...) calls but metadata declares ${p.metadata.steps.length} steps`,
    );
  }
}

// Used by review/report modules:
export function stepScreenshotName(stepNumber: number): string {
  return `step-${String(stepNumber).padStart(2, "0")}.png`;
}

const REPAIR_SYSTEM_PROMPT = `You are repairing one Playwright test that failed because its locator did not match anything in the rendered page.

Inputs you receive in the user message:
  1. The step description (the QA goal for this test).
  2. The original test body that failed.
  3. The Playwright failure message.
  4. The actual rendered HTML of the page at the moment the test failed (noise stripped).

Your job: produce a revised version of the SAME test, with locators that target real DOM nodes visible in the rendered HTML.

Rules:
- Output ONLY the revised test body (a single \`test("step-NN · ...", async ({ page }) => { ... })\` block). No markdown fences, no commentary, no JSON wrapper.
- Keep the exact step number and human-readable description in the test name (e.g. \`step-03 · ...\`).
- markAnnotations([...]) MUST remain the FIRST statement of the body. Update its selectors to match the new locators.
- Keep the same goto() URL the original used unless the rendered HTML clearly shows the wrong page was loaded.
- Use Playwright role/text/label/testid locators that you can verify are present in the supplied HTML. Prefer getByRole / getByText / getByTestId / [data-testid="..."] over brittle CSS paths.
- Keep the assertion intent the same. If the original was checking that something is visible, keep it as a visibility check on the equivalent real element.
- If the rendered HTML does not contain ANY evidence of the affordance the original was asserting on, output the literal string \`CANNOT_REPAIR\` and nothing else. (Caller will keep the original failure rather than invent a passing test.)
- No page.waitForTimeout, no page.evaluate unless genuinely needed.`;

export async function repairStepFromDom(args: {
  apiKey: string;
  stepDescription: string;
  originalTestBody: string;
  failureSummary: string;
  domHtml: string;
}): Promise<{ revisedTestBody: string } | { cannotRepair: true; reason: string }> {
  const { apiKey, stepDescription, originalTestBody, failureSummary, domHtml } = args;
  const client = new Anthropic({ apiKey });
  const trimmedHtml = stripNoiseFromHtml(domHtml).slice(0, 200_000);
  const userContent = [
    `Step description: ${stepDescription}`,
    "",
    "Original test body that failed:",
    "```ts",
    originalTestBody.trim(),
    "```",
    "",
    "Failure message:",
    failureSummary,
    "",
    "Actual rendered HTML at moment of failure (script/style/svg stripped):",
    "```html",
    trimmedHtml,
    "```",
  ].join("\n");
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: REPAIR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });
  const text = resp.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  if (text === "CANNOT_REPAIR" || /^CANNOT_REPAIR\b/.test(text)) {
    return { cannotRepair: true, reason: "Repair LLM declined: rendered DOM has no evidence of the affordance." };
  }
  const body = extractTestBlock(text);
  if (!body) {
    return { cannotRepair: true, reason: "Repair LLM response could not be parsed as a single test() block." };
  }
  return { revisedTestBody: body };
}

function extractTestBlock(text: string): string | null {
  // Strip code fences if present.
  const fenceMatch = text.match(/```(?:ts|tsx|typescript|javascript|js)?\s*([\s\S]*?)```/);
  const candidate = (fenceMatch ? fenceMatch[1] : text).trim();
  if (!/^test\(\s*["'`]/.test(candidate)) return null;
  return candidate;
}

function stripNoiseFromHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "<svg/>")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{3,}/g, "  ");
}

export type { PlanStepMetadata };
