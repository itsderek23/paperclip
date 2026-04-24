import fs from "node:fs/promises";
import path from "node:path";

/**
 * Writes `generated.spec.ts` and `playwright.config.ts` into `outDir`.
 * The spec body (one `test(...)` per step) is provided by the LLM; we wrap it
 * with imports, the annotate helper path resolution, and serial-mode config.
 */
export async function writeGeneratedSpec(args: {
  outDir: string;
  specBody: string;
  annotateHelperAbsPath: string;
}): Promise<{ specPath: string; configPath: string }> {
  const { outDir, specBody, annotateHelperAbsPath } = args;
  await fs.mkdir(outDir, { recursive: true });
  const specPath = path.join(outDir, "generated.spec.ts");
  const configPath = path.join(outDir, "playwright.config.ts");
  // Use an absolute import path so the spec works no matter where outDir lives.
  // Strip the .ts extension — tsx/Playwright test runner resolves modules without it.
  const annotateImport = annotateHelperAbsPath.replace(/\.ts$/, "");
  await fs.writeFile(specPath, renderSpec(specBody, annotateImport));
  await fs.writeFile(configPath, renderConfig());
  return { specPath, configPath };
}

function renderSpec(body: string, annotateImport: string): string {
  // NOTE: no test.describe.configure({ mode: "serial" }) — serial mode skips
  // subsequent tests when one fails, which defeats the point of capturing a
  // screenshot for EVERY step. With workers:1 in the config, tests still run
  // one at a time in file order; we just don't want failure to cascade.
  //
  // The afterEach hook both draws annotations (from markAnnotations() calls
  // made at the top of the test body) AND takes the screenshot, so both
  // happen even when a test threw mid-body. The test body calls
  // markAnnotations([...]) up front; it does NOT call annotate() or
  // page.screenshot() itself.
  return `import { test, expect } from "@playwright/test";
import { annotate, markAnnotations, readMarkedAnnotations } from "${annotateImport}";

const SCREENSHOT_DIR = process.env.RELEASEBOT_SCREENSHOT_DIR ?? ".";

test.afterEach(async ({ page }, testInfo) => {
  const m = testInfo.title.match(/step-(\\d+)/);
  if (!m) return;
  const file = \`\${SCREENSHOT_DIR}/step-\${m[1]}.png\`;
  try {
    const selectors = readMarkedAnnotations(testInfo);
    if (selectors.length > 0) await annotate(page, selectors);
    await page.screenshot({ path: file });
  } catch {
    // page may be closed if test aborted early; best-effort only.
  }
});

// Prevent unused-import warnings if the generated body omits these.
void markAnnotations;

${body.trim()}
`;
}

function renderConfig(): string {
  return `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "generated.spec.ts",
  timeout: 60_000,
  reporter: [["json", { outputFile: "results.json" }], ["list"]],
  use: {
    baseURL: process.env.RELEASEBOT_BASE_URL,
    viewport: { width: 1440, height: 900 },
    trace: "on",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  fullyParallel: false,
  workers: 1,
  outputDir: process.env.RELEASEBOT_RUN_OUTPUT ?? "./test-output",
});
`;
}
