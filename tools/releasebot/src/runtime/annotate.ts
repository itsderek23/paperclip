import type { Page } from "@playwright/test";

const MAX_MATCHES_PER_SELECTOR = 20;

/**
 * Draws red outline overlays around every match of each selector and labels
 * them with the 1-based index of the selector they came from. Call immediately
 * before `page.screenshot(...)`.
 *
 * Multiple elements matching the same selector all get outlined with the SAME
 * number — the label identifies which selector the box came from, not which
 * instance. A selector that matches e.g. both an inline ref and a sidebar pill
 * (common when the PR is about unifying rendering across surfaces) will draw
 * both boxes with label "1", which is exactly the signal the reviewer wants.
 *
 * Missing selectors are silently skipped (no throw) — this is a visual aid,
 * not an assertion.
 */
export async function annotate(page: Page, selectors: string[]): Promise<void> {
  const boxes: Array<{
    selectorIndex: number;
    box: { x: number; y: number; width: number; height: number };
  }> = [];

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

  await page.evaluate((data) => {
    const prev = document.getElementById("__releasebot_overlay__");
    if (prev) prev.remove();
    const overlay = document.createElement("div");
    overlay.id = "__releasebot_overlay__";
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    for (const item of data) {
      const outline = document.createElement("div");
      outline.style.cssText = [
        `position:absolute`,
        `left:${item.box.x}px`,
        `top:${item.box.y}px`,
        `width:${item.box.width}px`,
        `height:${item.box.height}px`,
        `outline:2px solid #ff3b30`,
        `box-shadow:0 0 0 1px rgba(255,255,255,0.9) inset`,
        `border-radius:2px`,
      ].join(";");
      const label = document.createElement("div");
      label.textContent = String(item.selectorIndex + 1);
      label.style.cssText = [
        `position:absolute`,
        `left:-8px`,
        `top:-8px`,
        `min-width:18px`,
        `height:18px`,
        `padding:0 5px`,
        `background:#ff3b30`,
        `color:#fff`,
        `font:600 11px/18px -apple-system,system-ui,sans-serif`,
        `text-align:center`,
        `border-radius:9px`,
        `box-shadow:0 0 0 1px #fff`,
      ].join(";");
      outline.appendChild(label);
      overlay.appendChild(outline);
    }
    document.body.appendChild(overlay);
  }, boxes);
}
