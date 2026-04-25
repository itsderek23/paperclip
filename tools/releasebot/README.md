# releasebot (PoC)

PR-replay visual QA for Paperclip and other apps. Given a PR number, checks out base + head into isolated worktrees, boots a stack on each, drives local Playwright against both with a diff-generated plan, annotates and screenshots the surfaces that changed, LLM-reviews the before/after pairs, and emits a markdown + HTML report.

Scope: proof of concept, local-only, not wired into CI. Three stack adapters today: `paperclip` (default), `caldiy`, `openwebui`. See `/Users/derek/.claude/plans/per-users-derek-downloads-releasebot-pit-elegant-backus.md` for the original plan.

## Usage

```
# Requires: gh auth status working, .env.local with ANTHROPIC_API_KEY at repo root
pnpm releasebot:pr 4224
pnpm releasebot:pr 28944 --stack caldiy     --repo /path/to/cal.diy
pnpm releasebot:pr 23918 --stack openwebui  --repo /path/to/open-webui

pnpm releasebot:pr 4224 --plan-only          # stop after plan generation
pnpm releasebot:pr 4224 --skip-install       # reuse existing worktrees (fails early if node_modules missing)
pnpm releasebot:pr 4224 --keep-stacks        # leave servers running after report; warms the SHA cache
pnpm releasebot:pr 4224 --no-reuse           # force cold boot, ignore any warm SHA-keyed stacks
pnpm releasebot:pr 4224 --parallel-boot      # boot before+after concurrently (regresses on CPU-bound hosts; default sequential)
pnpm releasebot:pr 4224 --clean              # remove worktrees after run, keep artifacts/
pnpm releasebot:pr 4224 --force-broken       # skip the upstream-CI preflight and run anyway
pnpm releasebot:pr 4224 --force-no-ui        # skip the no-UI-surface triage and run anyway
```

Artifacts land in `<repoRoot>/tmp/releasebot/<pr>/artifacts/`. Open `report.html` to see before/after pairs. `<repoRoot>` is the target app, resolved from `--repo` (or `RELEASEBOT_REPO`); for paperclip itself, it defaults to the monorepo root.

### Stack reuse: warm a base-SHA stack across PRs

Booted stacks are registered by SHA at `<repoRoot>/tmp/releasebot/.stacks/<sha>.json`. On subsequent runs, if a fingerprint exists for the expected SHA *and* the recorded PID is alive *and* the URL responds within 2s *and* the stack name matches, the runner skips `adapter.boot()` entirely and reuses the running process. A reuser is a *consumer* — its shutdown is a no-op, so the stack survives the consumer's exit. Only the run that originally booted with `--keep-stacks` owns the stack's lifecycle.

This unlocks a fast cross-PR QA loop. Most UI PRs branch from `main`, so the `before`-side stack is the same SHA across all of them:

```
# Step 1: warm a base-SHA stack once. Pick any PR whose base is the SHA you want warm.
pnpm releasebot:pr <recent-PR-against-main> --stack paperclip --keep-stacks

# Step 2: iterate. The warm before is reused; only the after-side fresh-boots per PR
# (and gets cleaned up at exit, since these calls don't pass --keep-stacks).
pnpm releasebot:pr <PR-A> --stack paperclip
pnpm releasebot:pr <PR-B> --stack paperclip
pnpm releasebot:pr <PR-C> --stack paperclip
```

Before each fresh boot, any stale fingerprint sitting on the target port with a different SHA is killed first, so the after-side can always claim port 3302 cleanly between PRs. Pass `--no-reuse` to force a cold boot.

### Preflight: upstream CI

Before spending time on worktrees + install + stack boots, the runner checks `gh pr view` for merge conflicts or failing checks (`verify`, `e2e`, etc.). If the PR is not buildable upstream, the run exits with code 3 and writes a `report.md` explaining the skip. Use `--force-broken` to override.

### Triage: no browsable UI surface

If the diff has zero `.tsx`/`.jsx`/`.svelte` changes under a UI-relevant path, there's no surface a visual QA run can exercise. The runner exits with code 3 and writes a `report.md` flagging the skip rather than letting the planner scope-drift onto some incidental UI hunk. Use `--force-no-ui` to override.

### Planner: grounded selectors with auto-retry

After the LLM produces a plan, the runner statically extracts every Playwright locator literal (`getByRole(... { name })`, `getByText`, `getByLabel`, `[data-testid]`, `[aria-label]`, etc.) and probes each against `source-context.txt` and the rendered values from `fixtures.before.json`. If any selector doesn't appear in either, the plan is regenerated once with explicit feedback naming the offending strings. After one retry, ungrounded selectors are logged as a warning and the run proceeds — the visual review will mark steps inconclusive at runtime if Playwright cannot find them.

### Stack-boot failure reports

When either side's Paperclip stack fails to boot (install issue, TypeScript build error, port conflict), a `report.md` is written with the failing side, the error message, and the last 40 lines of the boot log — so failed runs leave an audit trail instead of only stderr.

### Fast iteration on LLM stages

Full runs take ~5 minutes. The plan and review stages are pure functions of cached artifacts, so two flags let you re-enter them directly without worktrees, installs, stacks, or Playwright:

```
pnpm releasebot:pr 4224 --review-only        # re-run visual review + report, ~20-40s
pnpm releasebot:pr 4224 --plan-from-cache    # re-run planner, write a new plan.json, ~10-15s
pnpm releasebot:pr 4224 --report-only        # re-render report from existing review.json
```

`--review-only` reads `plan.json`, `before/steps.json`, `after/steps.json`, and the step-*.png screenshots; writes a fresh `review.json`, `report.md`, `report.html`. Use when iterating on the reviewer or summary prompts in `review.ts`.

`--plan-from-cache` reads `pr.json`, `diff.patch`, `source-context.txt`, and `fixtures.before.json`; writes a fresh `plan.json`. Use when iterating on the planner prompt in `plan.ts`. Behavioral validation of the new plan still requires a live run.

## Layout

```
src/
  cli.ts                # entry, arg parsing, orchestration
  pr.ts                 # gh shell-outs, diff fetch
  worktree.ts           # git worktree add/remove, pnpm install per side
  plan.ts               # Anthropic SDK: diff -> plan
  run.ts                # Playwright: navigate, annotate, screenshot
  review.ts             # Anthropic SDK (vision): per-step verdict + run summary
  report.ts             # markdown + single-file HTML
  stack/
    adapter.ts          # StackAdapter interface (generic)
    paperclip.ts        # PaperclipAdapter: boot + health + seed
    caldiy.ts           # CalDiyAdapter: per-side Postgres DBs, NextAuth credentials login
    openwebui.ts        # OpenWebUiAdapter: SQLite via DATA_DIR, signup-then-signin, seeded chat fixture
```

The `stack/` seam is the extraction boundary: everything outside it is repo-agnostic. See the plan's "Extraction trigger" for when to split.
