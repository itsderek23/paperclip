import type { Page } from "@playwright/test";

/**
 * Draws red outline overlays around each selector's bounding box and labels them
 * with 1-based numbers. Call immediately before `page.screenshot(...)`.
 *
 * Missing selectors are silently skipped (no throw) — this is a visual aid, not
 * an assertion. Use an explicit `expect(locator).toBeVisible()` for that.
 */
export async function annotate(page: Page, selectors: string[]): Promise<void> {
  const boxes: Array<{ box: { x: number; y: number; width: number; height: number } | null }> = [];
  for (const sel of selectors) {
    try {
      const box = await page.locator(sel).first().boundingBox({ timeout: 2_000 });
      boxes.push({ box });
    } catch {
      boxes.push({ box: null });
    }
  }
  await page.evaluate((data) => {
    const prev = document.getElementById("__releasebot_overlay__");
    if (prev) prev.remove();
    const overlay = document.createElement("div");
    overlay.id = "__releasebot_overlay__";
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    for (const [i, item] of data.entries()) {
      if (!item.box) continue;
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
      label.textContent = String(i + 1);
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
