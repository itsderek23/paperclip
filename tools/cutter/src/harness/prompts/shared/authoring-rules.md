## Plan-authoring rules

The spec body is injected into a Playwright file that already has these in scope:

```ts
import { test, expect } from "@playwright/test";
import { markAnnotations } from "<harness>";
const SCREENSHOT_DIR = process.env.RELEASEBOT_SCREENSHOT_DIR ?? ".";

// An afterEach hook is auto-injected that:
//   1. reads the selectors registered via markAnnotations(...) at the top of the test,
//   2. resolves their bounding boxes (used for focus-mode crops in the QA report),
//   3. takes step-NN.png.
// All three happen regardless of whether the test body threw.
```

Do NOT include imports, `SCREENSHOT_DIR`, `test.afterEach`, or `test.describe.configure` in your spec body — they are provided. Just emit the `test(...)` calls, in order.

### Test skeleton (every step must follow this)

```ts
test("step-NN · <short description>", async ({ page }) => {
  markAnnotations([/* 1-4 CSS selectors that target the changed region */]);
  await page.goto("<relative URL>");
  // interactions: locator.click(), .fill(), .hover(), keyboard.press(), etc.
  // assertions: await expect(locator).toBeVisible();  // or .toHaveText, .toHaveAttribute
  await locator.scrollIntoViewIfNeeded().catch(() => {});  // ALWAYS for the assertion target
  await page.waitForTimeout(400);                          // let layout settle before the implicit screenshot
});
```

`markAnnotations()` MUST be the FIRST statement in every test body. Calling it up-front means the afterEach hook can still resolve and persist the bboxes even if a subsequent `expect()` throws.

### Step numbering

- Number steps starting at 01. The step number in the test name MUST match `step-NN` in the screenshot filename and its index `(NN-1)` in `metadata.steps`.
- 1 to 6 steps. Each test is a complete, isolated scenario — no shared state between tests.

### Step descriptions (user-facing)

`metadata.steps[].description` is shown to human reviewers in a PR comment. Keep it generic — describe the *kind* of thing being tested, not the specific seeded record. Refer to entities generically ("an issue", "the descendant issue", "a subtask", "the assigned user", "the project"). Do NOT include seeded fixture ids/keys (PAP-1, PAP-6, REF-2, project codes, user emails) in the description — those are fine in selectors, URLs, and the test name, but not in this user-facing field.

### Below-the-fold rendering

`page.screenshot()` is **viewport-only** by default. The single most common reason a Playwright pass produces a "no visible diff" verdict is that the assertion target is below the fold. ALWAYS append:

```ts
await locator.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(400);
```

before the implicit screenshot — even if the target looks above the fold from the source.

### Selectors

- Prefer Playwright role/text/label/testid locators: `getByRole("button", { name: "..." })`, `getByLabel("...")`, `getByTestId("...")`, `getByText("...")`. Use stack-specific conventions noted in the adapter hints below.
- Annotation selectors (passed to `markAnnotations()`) should target DOM nodes the diff introduced or modified. Stable selectors only (role, aria-label, data-testid).
- If a selector matches multiple elements, all matches contribute to a single union region grouped under that selector — usually what you want for the focus-mode crop. To point at one region, scope the selector: `aside a[...]`, `[data-testid="issue-properties"] a`, etc.

### Assertions

- ONLY assert on things the diff actually introduces or modifies. Do NOT add "sanity" assertions on generic page structure (h1 presence, navbar links, etc.) — the diff didn't touch those, they're not a PR signal, and a failing sanity assertion halts the rest of the test.
- Aim for one assertion per test, the tightest possible to the diff.
- Pick `expect` targets that are specific to the diff — new copy, new `data-*` attributes, new component names. Never something that would also appear on a login / 404 / empty-state screen.
- Prefer Playwright locators + `expect` over text-substring checks. Avoid `page.waitForTimeout` (use `expect`'s auto-wait) except for the single 400ms layout-settle pause described above. No `page.evaluate` unless genuinely needed.

### Step granularity

- Prefer the SMALLEST number of steps that covers the diff. If the entire UI change is a single new region or piece of new copy on one page, that's ONE step.
- Do NOT split a single static section into one step per child element. Assert on the section's container or its heading once; the screenshot captures the rest.
- For text the PR introduced that is HIDDEN behind an interaction (menu button, tab, drawer, popover, dialog trigger), click the trigger FIRST, then assert on the new text. If the new content is visible on initial page load (a new settings section, new card on a list page, new banner, new copy in an existing visible region), do NOT add interaction steps — just navigate and assert.

### Reachability before targeting

Before you pick a route to navigate to and a locator to assert on, verify in the source that BOTH hold:

(a) The route's rendered output actually includes the changed component or region — i.e. the diff either adds/modifies the route itself, OR adds/modifies a consumer that mounts the changed component on that route. A component file edited but whose imports/mount sites are unchanged in this diff will NOT appear at runtime on routes that previously didn't render it.

(b) Any conditional or runtime gate around the new copy/region (a non-empty collection, an active session, a feature flag, an in-progress operation, an external callback) is satisfied by the available fixtures — otherwise the new affordance won't render and the assertion will fail regardless of the PR's correctness.

When (a) fails, drop the target — do not assert on a component the diff never wires up. When (b) fails and there is no fixture path to satisfy the gate, treat it as a coverage gate (use `metadata.coverageNote`).

Prefer routes that are themselves added or modified in this diff, since their entire rendered output is by definition in-scope.

### Smoke tests must be substantive

A smoke test is acceptable ONLY when source context shows the route demonstrably mounts the changed component or its consumer chain. Acceptable patterns:

1. **Component mounts on its host route** — assert the changed component's container is visible (not its conditionally-rendered inner content).
2. **Modified or added route smoke** — assert any element from the page's static frame on a route the diff itself adds or modifies.
3. **Renamed/reshaped prop reaches the page** — assert the consumer's container renders on a fixture-seeded page that demonstrably mounts it.
4. **Unconditional new copy** — assert literal new text whose JSX in source context shows no surrounding conditional.

Trivial smokes are NOT allowed: never assert generic page chrome (navbar links, app heading, route `/`) to "prove the app loads." If you cannot establish a mount path from source for the changed code, do NOT fall back to a trivial smoke — set `metadata.surface = "none"`.

### Coverage gates (`metadata.coverageNote`)

The diff's user-visible UI is sometimes gated on runtime state, live data, or anything the test environment can't synthesize — a scheduled retry pending, an in-progress run, a real third-party callback, a long-running animation mid-frame, an actual user with verified email. When you can identify such a gate AND you've deliberately fallen back to a smoke test (e.g. asserting the component still mounts on a real page, instead of asserting the new copy itself), set `metadata.coverageNote` to one short user-facing sentence explaining what we couldn't produce — generic, no record names.

Examples:
- `"The new retry-state badges only render when an issue has a scheduled retry pending, which fixtures can't produce."`
- `"The new in-progress upload UI only appears mid-upload, which the test can't simulate."`

Otherwise set `coverageNote` to `null`. Do NOT use this field for backend-only PRs with no UI surface (just `null`), and do NOT use it for ordinary PRs whose UI you can fully exercise.

### Surface declaration (`metadata.surface`)

Set `metadata.surface = "none"` (with `metadata.steps = []` and `spec = ""`) when, after reading the full source context, you cannot identify ANY substantive smoke pattern from the list above for this diff. Examples that warrant `"none"`: pure backend / CLI / migration / type refactor with no rendered-output change; UI files modified but only in non-rendered code paths (workers, utils, type re-exports); component files modified but the diff doesn't add or modify any consumer that mounts them on a navigable route in the seeded fixtures. When you set `"none"`, `metadata.rationale` must briefly explain in one sentence why no surface is validatable.

Set `metadata.surface = "ui"` (or omit) and produce 1–6 steps in every other case. Do NOT use this field as an escape hatch for hard-to-test runtime gates — that's what `coverageNote` is for.

If the diff has zero `ui/`, `*.tsx`, or `*.jsx` files, default to `surface: "none"` unless you can identify a non-`ui/` rendered surface.

### Template substitution

Use `{{name.field}}` to interpolate seeded identifiers from the fixture summary into your plan's URLs (`metadata.steps[].url`) and spec body. The harness substitutes these post-seed, after the seed extension has run on the after-side stack. You do not need to know the values upfront.
