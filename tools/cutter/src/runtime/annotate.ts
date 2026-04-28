import { test, type Page } from "@playwright/test";

const MAX_MATCHES_PER_SELECTOR = 20;

const ANNOTATION_TYPE = "cutter-annotate";

/**
 * Register the selectors whose bounding boxes the harness should record on
 * this test's screenshot. Call at the TOP of a test body (right after the
 * test declaration), BEFORE any expect() — so even if an assertion later
 * throws, the afterEach can still resolve and persist the bboxes.
 *
 * The selectors are stashed in the test's annotations array; the generated
 * spec's afterEach hook reads them and calls annotate(page, selectors)
 * before page.screenshot() to capture bboxes (used for focus-mode crops in
 * the QA report).
 */
export function markAnnotations(selectors: string[]): void {
  test.info().annotations.push({
    type: ANNOTATION_TYPE,
    description: JSON.stringify(selectors),
  });
}

/** Used by the generated spec's afterEach to recover the registered selectors. */
export function readMarkedAnnotations(
  testInfo: { annotations: Array<{ type: string; description?: string }> },
): string[] {
  for (const a of testInfo.annotations) {
    if (a.type !== ANNOTATION_TYPE) continue;
    try {
      const parsed = JSON.parse(a.description ?? "[]");
      if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string");
    } catch {
      // fall through
    }
  }
  return [];
}

export interface AnnotationBox {
  selectorIndex: number;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Resolves each selector's bounding boxes for downstream focus-mode crops
 * in the QA report. Does not paint anything on the page — the screenshot
 * the afterEach takes after this call is fully clean.
 *
 * Multiple matches of the same selector all share the same selectorIndex
 * — that index identifies which selector the box came from, not which
 * instance — so the report can union them into a single crop region.
 *
 * Missing selectors are silently skipped (no throw); this is data
 * collection, not an assertion.
 */
export async function annotate(page: Page, selectors: string[]): Promise<AnnotationBox[]> {
  const boxes: AnnotationBox[] = [];

  for (const [selectorIndex, sel] of selectors.entries()) {
    try {
      const locator = page.locator(sel);
      const count = Math.min(await locator.count(), MAX_MATCHES_PER_SELECTOR);
      for (let j = 0; j < count; j++) {
        const box = await locator
          .nth(j)
          .boundingBox({ timeout: 1_500 })
          .catch(() => null);
        if (box) boxes.push({ selectorIndex, box });
      }
    } catch {
      // selector didn't resolve at all — skip.
    }
  }

  return boxes;
}
