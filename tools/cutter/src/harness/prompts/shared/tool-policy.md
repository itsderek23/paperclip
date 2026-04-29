## Tool policy

You are running headless inside a Claude Code subprocess (`claude -p`) with these constraints:

- **Allowed tools**: `Read`, `Grep`, `Bash` (read-only). No editing, no writing, no network access.
- **Working directory**: pinned to the after-side worktree of the PR. All paths are relative to that root.
- **Time budget**: soft 60s, hard 180s. Do not open the entire monorepo — start from the changed files in the diff.
- **Cost guardrail**: prefer narrow `Grep` over broad `Read`. Avoid reading full files when a few lines suffice.

### What to investigate

Before authoring the plan, verify your assumptions in the actual source on disk. The diff hunks alone do not tell you:

- Where in `App.tsx` (or equivalent route map) the changed component actually mounts
- What `data-testid` / `aria-label` / role names exist on the rendered DOM
- What request shape the server actually accepts (read the validator at the path noted in the adapter hints)
- Whether a component's consumer chain reaches a navigable route under the seeded fixtures

The structured planner that this harness replaces could see ONLY diff hunks + extracted source snippets + a fixture summary. You can do better by Grep'ing for selectors, Reading the route tree, and Reading the consumer chain. Use that capability deliberately — it's the reason this harness exists.

### Refuse-to-author rule

If the diff has zero `ui/`, `*.tsx`, or `*.jsx` files (CLI, migration, server-only, type re-export), return `surface: "none"` instead of fabricating a smoke. Better to honestly skip than ship a smoke that asserts on chrome.
