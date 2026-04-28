## Output schema (strict — return ONLY this JSON object, no markdown fences, no commentary)

```json
{
  "plan": {
    "metadata": {
      "title": "string (<=60 chars, feature/scenario name)",
      "goal": "string (1 sentence QA-spec prose)",
      "rationale": "string (2-4 sentences tying each step to the diff)",
      "steps": [
        { "description": "string", "url": "string (relative)" }
      ],
      "coverageNote": "string | null  // see coverage gates rule",
      "surface": "ui | none  // default ui; when none, set steps: [] and spec: \"\""
    },
    "spec": "string  // TypeScript body: one test(...) per step. Empty when surface is none"
  },
  "baseSeed": null,
  "seedExtension": null
}
```

You return TWO seed specs (each may be `null`):

- **`baseSeed`** — applied to BOTH the before-side and after-side stacks. This is the realistic baseline data the UI needs to render anything (a company, a couple of issues, etc.). Without this, almost every page is an empty state. Author one whenever the plan asserts on routes that need a seeded company / issue / etc.
- **`seedExtension`** — applied to the AFTER-side stack only. Use this for entities that exercise the new feature added in this diff. Skip (set to `null`) when the new UI shows up against base-seeded data.

The before / after asymmetry is the point: the visual reviewer compares before-side (no extension) against after-side (with extension) screenshots. If you'd put an entity in both, put it in `baseSeed`. If it's only meaningful when the new code path is mounted, put it in `seedExtension`.

Each seed spec is a `FixtureSpec`:

```json
{
  "rationale": "string (2-4 sentences tying each entity to a UI surface from the diff)",
  "entities": [
    {
      "kind": "http",
      "name": "string",
      "endpoint": "POST /api/...",
      "body": { "...": "..." },
      "capture": { "id": "$.id" }
    }
  ]
}
```

`entities` is ordered — later entries may reference earlier captures via `{{name.field}}`.

Entity kinds:
- `kind: "http"` — POST to a write endpoint listed in the adapter hints. Default if `kind` omitted.
- `kind: "sql"` — raw SQL `INSERT` against the embedded postgres pool. Use ONLY for runtime-gated state with no public POST (heartbeat runs, scheduled retries, watchdog rows). `query` is a parameterized SQL string; `params` is an array of bind values.

Every captured field uses JSONPath syntax: `$.id`, `$.identifier`, `$.data[0].slug`. The captured map is what `{{name.field}}` resolves against in later entries and in your plan's URLs / spec.
