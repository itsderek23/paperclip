# releasebot (PoC)

PR-replay visual QA for Paperclip. Given a PR number, checks out base + head into isolated worktrees, boots a Paperclip stack on each, drives local Playwright against both with a diff-generated plan, annotates and screenshots the surfaces that changed, LLM-reviews the before/after pairs, and emits a markdown + HTML report.

Scope: proof of concept, local-only, not wired into CI. See `/Users/derek/.claude/plans/per-users-derek-downloads-releasebot-pit-elegant-backus.md` for the plan.

## Usage

```
# Requires: gh auth status working, .env.local with ANTHROPIC_API_KEY at repo root
pnpm releasebot:pr 4224
pnpm releasebot:pr 4224 --plan-only          # stop after plan generation
pnpm releasebot:pr 4224 --skip-install       # reuse existing worktrees
pnpm releasebot:pr 4224 --keep-stacks        # leave servers running after report
```

Artifacts land in `tmp/releasebot/<pr>/artifacts/`. Open `report.html` to see before/after pairs.

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
    paperclip.ts        # PaperclipAdapter: boot + health + seed (paperclip-specific)
```

The `stack/` seam is the extraction boundary: everything outside it is repo-agnostic. See the plan's "Extraction trigger" for when to split.
