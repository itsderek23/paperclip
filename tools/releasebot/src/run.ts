import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Page } from "playwright";
import type { Plan, Side, SideResult, StepResult } from "./types.ts";

const VIEWPORT = { width: 1440, height: 900 };
const NAV_TIMEOUT = 20_000;
const ASSERT_TIMEOUT = 10_000;

export async function runPlanAgainst(
  plan: Plan,
  baseUrl: string,
  side: Side,
  artifactsDir: string,
): Promise<SideResult> {
  const outDir = path.join(artifactsDir, side);
  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();

  const steps: StepResult[] = [];
  try {
    for (const [idx, step] of plan.steps.entries()) {
      const stepN = idx + 1;
      const screenshot = path.join(outDir, `step-${String(stepN).padStart(2, "0")}.png`);
      const result: StepResult = { step_n: stepN, status: "pass", screenshot };
      try {
        await page.goto(`${baseUrl}${step.url}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => {});
        try {
          await page.waitForFunction(
            (needle) => document.body.innerText.includes(needle),
            step.assert_contains,
            { timeout: ASSERT_TIMEOUT },
          );
        } catch (err) {
          result.status = "fail";
          result.error = `assert_contains "${step.assert_contains}" not found`;
        }
        if (step.annotate?.length) {
          await annotate(page, step.annotate);
        }
        await page.screenshot({ path: screenshot, fullPage: !!step.full_page });
        if (step.annotate?.length) {
          await page.evaluate(() => {
            document.getElementById("__releasebot_overlay__")?.remove();
          });
        }
      } catch (err) {
        result.status = "fail";
        result.error = (err as Error).message;
        try {
          await page.screenshot({ path: screenshot }).catch(() => {});
        } catch {}
      }
      steps.push(result);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  const result: SideResult = { side, baseUrl, steps };
  await fs.writeFile(path.join(outDir, "steps.json"), JSON.stringify(result, null, 2));
  return result;
}

async function annotate(page: Page, selectors: string[]): Promise<void> {
  const boxes: Array<{ sel: string; box: { x: number; y: number; width: number; height: number } | null }> = [];
  for (const sel of selectors) {
    try {
      const box = await page.locator(sel).first().boundingBox({ timeout: 2_000 });
      boxes.push({ sel, box });
    } catch {
      boxes.push({ sel, box: null });
    }
  }
  await page.evaluate((data) => {
    const prev = document.getElementById("__releasebot_overlay__");
    if (prev) prev.remove();
    const overlay = document.createElement("div");
    overlay.id = "__releasebot_overlay__";
    overlay.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    for (const [i, item] of data.entries()) {
      if (!item.box) continue;
      const box = document.createElement("div");
      box.style.cssText = [
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
      box.appendChild(label);
      overlay.appendChild(box);
    }
    document.body.appendChild(overlay);
  }, boxes);
}
