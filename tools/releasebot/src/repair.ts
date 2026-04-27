import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { repairStepFromDom } from "./plan.ts";
import { applySeedExtension, readExistingExtension, reviseSeedFromFailure } from "./reseed.ts";
import { triageStepFailure } from "./triage.ts";
import type { FixtureSpec, FixtureSummary, Plan, SideResult, StepResult, TriageAction } from "./types.ts";

const log = (msg: string): void => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

export async function runRepairPass(args: {
  plan: Plan;
  before: SideResult;
  after: SideResult;
  artifactsDir: string;
  apiKey: string;
  beforeBaseUrl: string;
}): Promise<{ after: SideResult; before: SideResult }> {
  const { plan, before, after, artifactsDir, apiKey, beforeBaseUrl } = args;
  const generatedDir = path.join(artifactsDir, "generated", "after");
  const screenshotDir = path.join(artifactsDir, "after");
  const specPath = path.join(generatedDir, "generated.spec.ts");
  const configPath = path.join(generatedDir, "playwright.config.ts");

  const beforeGeneratedDir = path.join(artifactsDir, "generated", "before");
  const beforeScreenshotDir = path.join(artifactsDir, "before");
  const beforeSpecPath = path.join(beforeGeneratedDir, "generated.spec.ts");
  const beforeConfigPath = path.join(beforeGeneratedDir, "playwright.config.ts");

  let updatedAfter: SideResult = after;
  let updatedBefore: SideResult = before;
  let specSource: string | null = null;
  let beforeSpecSource: string | null = null;

  // Load shared context once. The triage call needs fixtures + diff for every step.
  let fixtures: FixtureSummary = {};
  try {
    fixtures = JSON.parse(await fs.readFile(path.join(artifactsDir, "fixtures.after.json"), "utf8")) as FixtureSummary;
  } catch {
    log("  repair: fixtures.after.json not readable — triage will run with empty fixture summary.");
  }
  let diff = "";
  try {
    diff = await fs.readFile(path.join(artifactsDir, "diff.patch"), "utf8");
  } catch {
    log("  repair: diff.patch not readable — triage will run without diff context.");
  }

  for (let i = 0; i < after.steps.length; i++) {
    const afterStep = updatedAfter.steps[i];
    const stepMeta = plan.metadata.steps[i];
    if (!afterStep || !stepMeta) continue;
    if (afterStep.status !== "fail") continue;

    const stepN = afterStep.step_n;
    const padded = String(stepN).padStart(2, "0");
    const errorText = afterStep.error ?? "";

    if (specSource === null) {
      try {
        specSource = await fs.readFile(specPath, "utf8");
      } catch {
        log(`  repair: could not read spec at ${specPath}; aborting repair pass.`);
        return { after: updatedAfter, before: updatedBefore };
      }
    }

    const originalTestBody = extractTestForStep(specSource, stepN);
    if (!originalTestBody) {
      log(`  repair step ${padded}: could not locate test block in spec; skipping.`);
      continue;
    }

    const domPath = path.join(screenshotDir, `step-${padded}.html`);
    let domHtml: string;
    try {
      domHtml = await fs.readFile(domPath, "utf8");
    } catch {
      log(`  repair step ${padded}: no DOM snapshot at ${domPath}; skipping.`);
      continue;
    }

    let screenshotBytes: Uint8Array | undefined;
    try {
      screenshotBytes = await fs.readFile(path.join(screenshotDir, `step-${padded}.png`));
    } catch {
      // OK — triage works text-only.
    }

    log(`  repair step ${padded}: triaging failure (one LLM call to pick action)...`);
    let action: TriageAction;
    try {
      action = await triageStepFailure({
        apiKey,
        stepDescription: stepMeta.description,
        failedStepUrl: stepMeta.url,
        originalTestBody,
        failureSummary: errorText,
        domHtml,
        fixtures,
        diff,
        screenshotBytes,
      });
    } catch (err) {
      log(`  repair step ${padded}: triage LLM call threw (${(err as Error).message}); keeping original failure.`);
      updatedAfter = patchStep(updatedAfter, i, {
        ...afterStep,
        repair: {
          outcome: "failed",
          reason: `Triage LLM threw: ${(err as Error).message}`,
          originalError: errorText,
          originalTestBody,
        },
      });
      continue;
    }

    log(`  repair step ${padded}: triage chose "${action.kind}" — ${action.reason.slice(0, 200)}`);

    switch (action.kind) {
      case "give_up": {
        updatedAfter = patchStep(updatedAfter, i, {
          ...afterStep,
          status: "inconclusive",
          error: `Triage declined to repair: ${action.reason}`,
          repair: {
            outcome: "triage_give_up",
            reason: action.reason,
            originalError: errorText,
            originalTestBody,
          },
        });
        continue;
      }

      case "rewrite_url": {
        const originalSnapshot = await snapshotOriginalArtifacts(screenshotDir, padded);
        const patched = replaceGotoInTest(specSource, stepN, action.suggestedUrl);
        if (!patched) {
          log(`  repair step ${padded}: could not splice new goto URL into test; keeping original failure.`);
          updatedAfter = patchStep(updatedAfter, i, {
            ...afterStep,
            repair: {
              outcome: "failed",
              reason: `Triage chose rewrite_url(${action.suggestedUrl}) but spec splice failed.`,
              originalError: errorText,
              originalTestBody,
            },
          });
          continue;
        }
        await fs.writeFile(specPath, patched, "utf8");
        specSource = patched;

        const grepPattern = `step-${padded}`;
        log(`  repair step ${padded}: rewrote goto → "${action.suggestedUrl}"; re-running with --grep "${grepPattern}"...`);
        await runPlaywrightGrep({ configPath, cwd: generatedDir, grep: grepPattern, baseUrl: after.baseUrl, screenshotDir });
        const rerunStatus = await readPlaywrightStatusForStep(path.join(generatedDir, "results.json"), stepN);

        const newScreenshot = path.join(screenshotDir, `step-${padded}.png`);
        const revisedTestBody = extractTestForStep(patched, stepN) ?? undefined;
        updatedAfter = patchStep(updatedAfter, i, {
          ...afterStep,
          status: rerunStatus.status,
          error: rerunStatus.error,
          screenshot: newScreenshot,
          bboxes: await readBboxes(screenshotDir, padded),
          repair: {
            outcome: "url_rewritten",
            reason:
              rerunStatus.status === "pass"
                ? `Triage rewrote goto → ${action.suggestedUrl}; rerun passed. ${action.reason}`
                : `Triage rewrote goto → ${action.suggestedUrl}; rerun did not pass. ${action.reason}`,
            originalError: errorText,
            originalTestBody,
            revisedTestBody,
            ...(originalSnapshot ? { originalScreenshot: path.relative(artifactsDir, originalSnapshot) } : {}),
          },
        });
        ({ updatedBefore, beforeSpecSource } = await mirrorPatchToBefore({
          stepN,
          padded,
          patchedAfterSpec: patched,
          beforeSpecPath,
          beforeConfigPath,
          beforeGeneratedDir,
          beforeScreenshotDir,
          beforeBaseUrl,
          beforeSpecSource,
          updatedBefore,
          stepIndex: i,
        }));
        continue;
      }

      case "rewrite_locator": {
        const result = await applyLocatorRewrite({
          apiKey,
          artifactsDir,
          generatedDir,
          screenshotDir,
          specPath,
          configPath,
          baseUrl: after.baseUrl,
          stepN,
          padded,
          stepDescription: stepMeta.description,
          originalTestBody,
          errorText,
          domHtml,
          specSource,
          triageReason: action.reason,
        });
        if (result.specSource) specSource = result.specSource;
        updatedAfter = patchStep(updatedAfter, i, { ...afterStep, ...result.stepPatch });
        if (result.specSource) {
          ({ updatedBefore, beforeSpecSource } = await mirrorPatchToBefore({
            stepN,
            padded,
            patchedAfterSpec: result.specSource,
            beforeSpecPath,
            beforeConfigPath,
            beforeGeneratedDir,
            beforeScreenshotDir,
            beforeBaseUrl,
            beforeSpecSource,
            updatedBefore,
            stepIndex: i,
          }));
        }
        continue;
      }

      case "extend_seed": {
        const result = await applyExtendSeed({
          apiKey,
          artifactsDir,
          generatedDir,
          screenshotDir,
          specPath,
          configPath,
          afterBaseUrl: after.baseUrl,
          stepN,
          padded,
          stepMeta: { description: stepMeta.description, url: stepMeta.url },
          originalTestBody,
          errorText,
          domHtml,
          domPath,
          specSource,
          triageReason: action.reason,
        });
        if (result.specSource) specSource = result.specSource;
        updatedAfter = patchStep(updatedAfter, i, { ...afterStep, ...result.stepPatch });
        if (result.specSource) {
          ({ updatedBefore, beforeSpecSource } = await mirrorPatchToBefore({
            stepN,
            padded,
            patchedAfterSpec: result.specSource,
            beforeSpecPath,
            beforeConfigPath,
            beforeGeneratedDir,
            beforeScreenshotDir,
            beforeBaseUrl,
            beforeSpecSource,
            updatedBefore,
            stepIndex: i,
          }));
        }
        continue;
      }
    }
  }

  await fs.writeFile(path.join(screenshotDir, "steps.json"), JSON.stringify(updatedAfter, null, 2));
  await fs.writeFile(path.join(beforeScreenshotDir, "steps.json"), JSON.stringify(updatedBefore, null, 2));
  return { after: updatedAfter, before: updatedBefore };
}

async function mirrorPatchToBefore(opts: {
  stepN: number;
  padded: string;
  patchedAfterSpec: string;
  beforeSpecPath: string;
  beforeConfigPath: string;
  beforeGeneratedDir: string;
  beforeScreenshotDir: string;
  beforeBaseUrl: string;
  beforeSpecSource: string | null;
  updatedBefore: SideResult;
  stepIndex: number;
}): Promise<{ updatedBefore: SideResult; beforeSpecSource: string }> {
  const {
    stepN, padded, patchedAfterSpec, beforeSpecPath, beforeConfigPath,
    beforeGeneratedDir, beforeScreenshotDir, beforeBaseUrl, updatedBefore, stepIndex,
  } = opts;
  let { beforeSpecSource } = opts;

  const revisedTestBody = extractTestForStep(patchedAfterSpec, stepN);
  if (!revisedTestBody) {
    log(`  repair step ${padded}: could not extract revised test from after spec; skipping before-side mirror.`);
    return { updatedBefore, beforeSpecSource: beforeSpecSource ?? "" };
  }

  if (beforeSpecSource === null) {
    try {
      beforeSpecSource = await fs.readFile(beforeSpecPath, "utf8");
    } catch {
      log(`  repair step ${padded}: before spec at ${beforeSpecPath} unreadable; skipping before-side mirror.`);
      return { updatedBefore, beforeSpecSource: "" };
    }
  }

  const patchedBefore = replaceTestForStep(beforeSpecSource, stepN, revisedTestBody);
  if (!patchedBefore) {
    log(`  repair step ${padded}: before-side spec splice failed; skipping mirror.`);
    return { updatedBefore, beforeSpecSource };
  }
  await fs.writeFile(beforeSpecPath, patchedBefore, "utf8");
  await snapshotOriginalArtifacts(beforeScreenshotDir, padded);

  log(`  repair step ${padded}: mirroring patched test to before-side and re-running against ${beforeBaseUrl}...`);
  await runPlaywrightGrep({
    configPath: beforeConfigPath,
    cwd: beforeGeneratedDir,
    grep: `step-${padded}`,
    baseUrl: beforeBaseUrl,
    screenshotDir: beforeScreenshotDir,
  });
  const rerunStatus = await readPlaywrightStatusForStep(
    path.join(beforeGeneratedDir, "results.json"),
    stepN,
  );

  const beforeStep = updatedBefore.steps[stepIndex];
  const newScreenshot = path.join(beforeScreenshotDir, `step-${padded}.png`);
  const newRawScreenshot = newScreenshot.replace(/\.png$/, ".raw.png");
  const newBboxes = await readBboxes(beforeScreenshotDir, padded);
  const patched: StepResult = {
    ...beforeStep,
    step_n: stepN,
    status: rerunStatus.status,
    error: rerunStatus.error,
    screenshot: newScreenshot,
    rawScreenshot: newRawScreenshot,
    ...(newBboxes ? { bboxes: newBboxes } : {}),
  };
  return {
    updatedBefore: patchStep(updatedBefore, stepIndex, patched),
    beforeSpecSource: patchedBefore,
  };
}

interface RewriteOutcome {
  stepPatch: Partial<StepResult>;
  specSource?: string;
}

async function applyLocatorRewrite(opts: {
  apiKey: string;
  artifactsDir: string;
  generatedDir: string;
  screenshotDir: string;
  specPath: string;
  configPath: string;
  baseUrl: string;
  stepN: number;
  padded: string;
  stepDescription: string;
  originalTestBody: string;
  errorText: string;
  domHtml: string;
  specSource: string;
  triageReason: string;
}): Promise<RewriteOutcome> {
  const {
    apiKey, artifactsDir, generatedDir, screenshotDir, specPath, configPath, baseUrl,
    stepN, padded, stepDescription, originalTestBody, errorText, domHtml, specSource, triageReason,
  } = opts;

  let repair: Awaited<ReturnType<typeof repairStepFromDom>>;
  try {
    repair = await repairStepFromDom({
      apiKey,
      stepDescription,
      originalTestBody,
      failureSummary: errorText,
      domHtml,
    });
  } catch (err) {
    return {
      stepPatch: {
        repair: {
          outcome: "failed",
          reason: `Triage chose rewrite_locator but the rewrite LLM threw: ${(err as Error).message}. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }

  if ("cannotRepair" in repair) {
    return {
      stepPatch: {
        repair: {
          outcome: "failed",
          reason: `Triage chose rewrite_locator but the rewrite LLM returned CANNOT_REPAIR: ${repair.reason}. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }

  const originalSnapshot = await snapshotOriginalArtifacts(screenshotDir, padded);
  const patched = replaceTestForStep(specSource, stepN, repair.revisedTestBody);
  if (!patched) {
    return {
      stepPatch: {
        repair: {
          outcome: "failed",
          reason: "Triage chose rewrite_locator but spec splice failed.",
          originalError: errorText,
          originalTestBody,
          revisedTestBody: repair.revisedTestBody,
        },
      },
    };
  }
  await fs.writeFile(specPath, patched, "utf8");

  const grepPattern = `step-${padded}`;
  log(`  repair step ${padded}: rewrote locators; re-running with --grep "${grepPattern}"...`);
  await runPlaywrightGrep({ configPath, cwd: generatedDir, grep: grepPattern, baseUrl, screenshotDir });
  const rerunStatus = await readPlaywrightStatusForStep(path.join(generatedDir, "results.json"), stepN);

  return {
    specSource: patched,
    stepPatch: {
      status: rerunStatus.status,
      error: rerunStatus.error,
      screenshot: path.join(screenshotDir, `step-${padded}.png`),
      bboxes: await readBboxes(screenshotDir, padded),
      repair: {
        outcome: "applied",
        reason:
          rerunStatus.status === "pass"
            ? `Triage chose rewrite_locator; rewrite passed. ${triageReason}`
            : `Triage chose rewrite_locator; rewrite did not pass. ${triageReason}`,
        originalError: errorText,
        originalTestBody,
        revisedTestBody: repair.revisedTestBody,
        ...(originalSnapshot ? { originalScreenshot: path.relative(artifactsDir, originalSnapshot) } : {}),
      },
    },
  };
}

async function applyExtendSeed(opts: {
  apiKey: string;
  artifactsDir: string;
  generatedDir: string;
  screenshotDir: string;
  specPath: string;
  configPath: string;
  afterBaseUrl: string;
  stepN: number;
  padded: string;
  stepMeta: { description: string; url: string };
  originalTestBody: string;
  errorText: string;
  domHtml: string;
  domPath: string;
  specSource: string;
  triageReason: string;
}): Promise<RewriteOutcome> {
  const {
    apiKey, artifactsDir, generatedDir, screenshotDir, specPath, configPath, afterBaseUrl,
    stepN, padded, stepMeta, originalTestBody, errorText, domHtml, domPath, specSource, triageReason,
  } = opts;

  // Idempotency guard: skip if a previous run already extended the seed for this PR/SHA.
  const existingExtension = await readExistingExtension(artifactsDir);
  if (existingExtension && existingExtension.entities.length > 0) {
    return {
      stepPatch: {
        status: "inconclusive",
        error: `Triage chose extend_seed but a prior run already wrote fixture-spec.extension.json (${existingExtension.entities.length} entities). Use --no-reuse to start from a clean stack.`,
        repair: {
          outcome: "seed_extension_failed",
          reason: `Idempotency guard blocked re-extension. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }

  // Load original spec + fixtures for the seed-revision call.
  let originalSpec: FixtureSpec;
  try {
    originalSpec = JSON.parse(await fs.readFile(path.join(artifactsDir, "fixture-spec.json"), "utf8")) as FixtureSpec;
  } catch (err) {
    return {
      stepPatch: {
        repair: {
          outcome: "seed_extension_failed",
          reason: `Could not read fixture-spec.json: ${(err as Error).message}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }
  let existingFixtures: FixtureSummary;
  try {
    existingFixtures = JSON.parse(await fs.readFile(path.join(artifactsDir, "fixtures.after.json"), "utf8")) as FixtureSummary;
  } catch (err) {
    return {
      stepPatch: {
        repair: {
          outcome: "seed_extension_failed",
          reason: `Could not read fixtures.after.json: ${(err as Error).message}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }
  let diff = "";
  try {
    diff = await fs.readFile(path.join(artifactsDir, "diff.patch"), "utf8");
  } catch {
    // OK — diff is informational here.
  }

  let screenshotBytes: Uint8Array | undefined;
  try {
    screenshotBytes = await fs.readFile(path.join(screenshotDir, `step-${padded}.png`));
  } catch { /* OK */ }

  let revision: Awaited<ReturnType<typeof reviseSeedFromFailure>>;
  try {
    revision = await reviseSeedFromFailure({
      apiKey,
      originalSpec,
      existingFixtures,
      failedStepDescription: stepMeta.description,
      failedStepUrl: stepMeta.url,
      failureSummary: errorText,
      domHtml,
      diff,
      screenshotBytes,
    });
  } catch (err) {
    return {
      stepPatch: {
        repair: {
          outcome: "seed_extension_failed",
          reason: `Seed-revision LLM threw: ${(err as Error).message}. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }
  if ("cannotExtend" in revision) {
    return {
      stepPatch: {
        status: "inconclusive",
        error: `Triage chose extend_seed but the executor declined: ${revision.reason}`,
        repair: {
          outcome: "seed_extension_failed",
          reason: `Executor declined despite triage choice. Executor: ${revision.reason}. Triage: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }

  let applied: Awaited<ReturnType<typeof applySeedExtension>>;
  try {
    applied = await applySeedExtension({
      baseUrl: afterBaseUrl,
      existingFixtures,
      extensionEntities: revision.extensionEntities,
      artifactsDir,
      rationale: revision.rationale,
    });
  } catch (err) {
    return {
      stepPatch: {
        repair: {
          outcome: "seed_extension_failed",
          reason: `Applying seed extension failed: ${(err as Error).message}. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }
  if (applied.failedEntityNames.length === revision.extensionEntities.length) {
    return {
      stepPatch: {
        repair: {
          outcome: "seed_extension_failed",
          reason: `All ${revision.extensionEntities.length} extension entities failed to POST. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
        },
      },
    };
  }

  const addedEntities = applied.appliedEntities
    .filter((e) => !applied.failedEntityNames.includes(e.name))
    .map((e) => e.name);

  // Snapshot originals before rerun overwrites them.
  const originalSnapshot = await snapshotOriginalArtifacts(screenshotDir, padded);

  // Try original test verbatim against extended fixtures.
  const grepPattern = `step-${padded}`;
  log(`  repair step ${padded}: seed extended (added ${addedEntities.join(", ") || "none"}); re-running original test with --grep "${grepPattern}"...`);
  await runPlaywrightGrep({ configPath, cwd: generatedDir, grep: grepPattern, baseUrl: afterBaseUrl, screenshotDir });
  const verbatimRerun = await readPlaywrightStatusForStep(path.join(generatedDir, "results.json"), stepN);

  if (verbatimRerun.status === "pass") {
    return {
      stepPatch: {
        status: "pass",
        error: undefined,
        screenshot: path.join(screenshotDir, `step-${padded}.png`),
        bboxes: await readBboxes(screenshotDir, padded),
        repair: {
          outcome: "seed_extended",
          reason: `Triage chose extend_seed; original test passed against extended fixtures. ${triageReason}`,
          originalError: errorText,
          originalTestBody,
          seedExtensionRationale: revision.rationale,
          addedEntities,
          ...(originalSnapshot ? { originalScreenshot: path.relative(artifactsDir, originalSnapshot) } : {}),
        },
      },
    };
  }

  // Verbatim still fails. Try a Shape A locator rewrite against the post-extension DOM.
  let postExtensionDom: string;
  try {
    postExtensionDom = await fs.readFile(domPath, "utf8");
  } catch {
    return {
      stepPatch: {
        status: "fail",
        error: verbatimRerun.error ?? errorText,
        screenshot: path.join(screenshotDir, `step-${padded}.png`),
        bboxes: await readBboxes(screenshotDir, padded),
        repair: {
          outcome: "seed_extension_failed",
          reason: `Seed extension applied but post-extension DOM unreadable. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
          seedExtensionRationale: revision.rationale,
          addedEntities,
        },
      },
    };
  }

  let domRepair: Awaited<ReturnType<typeof repairStepFromDom>>;
  try {
    domRepair = await repairStepFromDom({
      apiKey,
      stepDescription: stepMeta.description,
      originalTestBody,
      failureSummary: verbatimRerun.error ?? errorText,
      domHtml: postExtensionDom,
    });
  } catch (err) {
    return {
      stepPatch: {
        status: "fail",
        error: verbatimRerun.error ?? errorText,
        screenshot: path.join(screenshotDir, `step-${padded}.png`),
        bboxes: await readBboxes(screenshotDir, padded),
        repair: {
          outcome: "seed_extension_failed",
          reason: `Post-extension DOM rewrite LLM threw: ${(err as Error).message}. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
          seedExtensionRationale: revision.rationale,
          addedEntities,
        },
      },
    };
  }
  if ("cannotRepair" in domRepair) {
    return {
      stepPatch: {
        status: "fail",
        error: verbatimRerun.error ?? errorText,
        screenshot: path.join(screenshotDir, `step-${padded}.png`),
        bboxes: await readBboxes(screenshotDir, padded),
        repair: {
          outcome: "seed_extension_failed",
          reason: `Seed extended but post-extension DOM rewrite refused: ${domRepair.reason}. Triage reason: ${triageReason}`,
          originalError: errorText,
          originalTestBody,
          seedExtensionRationale: revision.rationale,
          addedEntities,
        },
      },
    };
  }

  const patched = replaceTestForStep(specSource, stepN, domRepair.revisedTestBody);
  if (!patched) {
    return {
      stepPatch: {
        status: "fail",
        error: verbatimRerun.error ?? errorText,
        repair: {
          outcome: "seed_extension_failed",
          reason: "Seed extended and post-extension rewrite produced, but spec splice failed.",
          originalError: errorText,
          originalTestBody,
          seedExtensionRationale: revision.rationale,
          addedEntities,
          revisedTestBody: domRepair.revisedTestBody,
        },
      },
    };
  }
  await fs.writeFile(specPath, patched, "utf8");
  log(`  repair step ${padded}: seed extended + locator rewritten; re-running with --grep "${grepPattern}"...`);
  await runPlaywrightGrep({ configPath, cwd: generatedDir, grep: grepPattern, baseUrl: afterBaseUrl, screenshotDir });
  const finalRerun = await readPlaywrightStatusForStep(path.join(generatedDir, "results.json"), stepN);

  return {
    specSource: patched,
    stepPatch: {
      status: finalRerun.status,
      error: finalRerun.error,
      screenshot: path.join(screenshotDir, `step-${padded}.png`),
      bboxes: await readBboxes(screenshotDir, padded),
      repair: {
        outcome: finalRerun.status === "pass" ? "seed_extended" : "seed_extension_failed",
        reason:
          finalRerun.status === "pass"
            ? `Triage chose extend_seed; seed extended + locator rewritten; rerun passed. ${triageReason}`
            : `Triage chose extend_seed; seed extended + locator rewritten; rerun did not pass. ${triageReason}`,
        originalError: errorText,
        originalTestBody,
        revisedTestBody: domRepair.revisedTestBody,
        seedExtensionRationale: revision.rationale,
        addedEntities,
        ...(originalSnapshot ? { originalScreenshot: path.relative(artifactsDir, originalSnapshot) } : {}),
      },
    },
  };
}

function patchStep(side: SideResult, index: number, replacement: StepResult): SideResult {
  const steps = side.steps.slice();
  steps[index] = replacement;
  return { ...side, steps };
}

function extractTestForStep(spec: string, stepN: number): string | null {
  const padded = String(stepN).padStart(2, "0");
  const startRe = new RegExp(`test\\(\\s*["'\`]step-${padded}\\b[\\s\\S]*?=>\\s*\\{`, "m");
  const m = startRe.exec(spec);
  if (!m) return null;
  const bodyOpenIdx = m.index + m[0].length - 1;
  const end = findMatchingBraceEnd(spec, bodyOpenIdx);
  if (end < 0) return null;
  let i = end + 1;
  while (i < spec.length && /\s/.test(spec[i])) i++;
  if (spec[i] !== ")") return null;
  i++;
  while (i < spec.length && /[\s;]/.test(spec[i])) {
    if (spec[i] === ";") { i++; break; }
    i++;
  }
  return spec.slice(m.index, i);
}

function replaceTestForStep(spec: string, stepN: number, replacement: string): string | null {
  const original = extractTestForStep(spec, stepN);
  if (!original) return null;
  return spec.replace(original, replacement.trim());
}

function replaceGotoInTest(spec: string, stepN: number, newUrl: string): string | null {
  const original = extractTestForStep(spec, stepN);
  if (!original) return null;
  // Replace the FIRST page.goto("...") within the test body (typical test shape).
  // If the test has multiple gotos, only the first is rewritten — chained navigations
  // are rare and triage's URL fix is for the entry point.
  const gotoRe = /(page\s*\.\s*goto\s*\(\s*)(["'`])([^"'`]+)\2/;
  if (!gotoRe.test(original)) return null;
  const replaced = original.replace(gotoRe, `$1$2${newUrl}$2`);
  if (replaced === original) return null;
  return spec.replace(original, replaced);
}

function findMatchingBraceEnd(s: string, openIdx: number): number {
  let depth = 0;
  let inSingle = false, inDouble = false, inBacktick = false, inLine = false, inBlock = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : "";
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "/" && prev === "*") inBlock = false;
      continue;
    }
    if (inSingle) {
      if (c === "\\") { i++; continue; }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (c === "\\") { i++; continue; }
      if (c === "`") inBacktick = false;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") { inLine = true; continue; }
    if (c === "/" && s[i + 1] === "*") { inBlock = true; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "`") { inBacktick = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

async function snapshotOriginalArtifacts(screenshotDir: string, padded: string): Promise<string | undefined> {
  const png = path.join(screenshotDir, `step-${padded}.png`);
  const html = path.join(screenshotDir, `step-${padded}.html`);
  const bboxes = path.join(screenshotDir, `step-${padded}.bboxes.json`);
  const crop = path.join(screenshotDir, `step-${padded}.crop.png`);
  const targets: Array<[string, string]> = [
    [png, png.replace(/\.png$/, ".original.png")],
    [html, html.replace(/\.html$/, ".original.html")],
    [bboxes, bboxes.replace(/\.bboxes\.json$/, ".original.bboxes.json")],
    [crop, crop.replace(/\.crop\.png$/, ".original.crop.png")],
  ];
  let savedPng: string | undefined;
  for (const [src, dst] of targets) {
    try {
      // Don't clobber an existing original snapshot — first failure wins.
      await fs.access(dst);
      if (src === png) savedPng = dst;
    } catch {
      try {
        await fs.rename(src, dst);
        if (src === png) savedPng = dst;
      } catch {
        // file may not exist; skip.
      }
    }
  }
  return savedPng;
}

async function readBboxes(screenshotDir: string, padded: string): Promise<{ x: number; y: number; width: number; height: number }[] | undefined> {
  try {
    const raw = await fs.readFile(path.join(screenshotDir, `step-${padded}.bboxes.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const out: { x: number; y: number; width: number; height: number }[] = [];
    for (const r of parsed) {
      if (
        r && typeof r === "object" &&
        typeof r.x === "number" && typeof r.y === "number" &&
        typeof r.width === "number" && typeof r.height === "number"
      ) {
        out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function runPlaywrightGrep(opts: {
  configPath: string;
  cwd: string;
  grep: string;
  baseUrl: string;
  screenshotDir: string;
}): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const releasebotNodeModules = path.resolve(here, "..", "node_modules");
  const playwrightCli = path.join(releasebotNodeModules, "@playwright", "test", "cli.js");
  const existingNodePath = process.env.NODE_PATH ?? "";
  const nodePath = existingNodePath
    ? `${releasebotNodeModules}${path.delimiter}${existingNodePath}`
    : releasebotNodeModules;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [playwrightCli, "test", "--config", opts.configPath, "--grep", opts.grep],
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          NODE_PATH: nodePath,
          RELEASEBOT_BASE_URL: opts.baseUrl,
          RELEASEBOT_SCREENSHOT_DIR: opts.screenshotDir,
          RELEASEBOT_RUN_OUTPUT: path.join(opts.cwd, "test-output"),
        },
        stdio: "inherit",
      },
    );
    proc.on("exit", () => resolve());
    proc.on("error", reject);
  });
}

async function readPlaywrightStatusForStep(
  resultsPath: string,
  stepN: number,
): Promise<{ status: "pass" | "fail"; error?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(resultsPath, "utf8");
  } catch {
    return { status: "fail", error: "Playwright did not produce results.json on rerun" };
  }
  const padded = String(stepN).padStart(2, "0");
  const parsed = JSON.parse(raw) as PlaywrightReport;
  const tcs: PlaywrightTestCase[] = [];
  const visit = (s: PlaywrightSuite): void => {
    for (const spec of s.specs ?? []) {
      for (const tc of spec.tests ?? []) {
        tcs.push({ title: spec.title, results: tc.results ?? [] });
      }
    }
    for (const child of s.suites ?? []) visit(child);
  };
  for (const s of parsed.suites ?? []) visit(s);
  const tc = tcs.find((t) => t.title.includes(`step-${padded}`));
  if (!tc) return { status: "fail", error: `Rerun produced no result for step-${padded}` };
  const last = tc.results[tc.results.length - 1];
  const status = last?.status === "passed" ? "pass" : "fail";
  if (status === "pass") return { status: "pass" };
  return {
    status: "fail",
    error: last?.error?.message?.split("\n").slice(0, 3).join(" ").slice(0, 400) ?? last?.status ?? "rerun failed",
  };
}

interface PlaywrightReport { suites?: PlaywrightSuite[] }
interface PlaywrightSuite {
  specs?: Array<{ title: string; tests?: Array<{ results?: PlaywrightResult[] }> }>;
  suites?: PlaywrightSuite[];
}
interface PlaywrightTestCase { title: string; results: PlaywrightResult[] }
interface PlaywrightResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  error?: { message?: string; stack?: string };
}
