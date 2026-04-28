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
  "seedExtension": null
}
```

If the base seed is sufficient for the diff, set `seedExtension` to `null`. Otherwise return a `FixtureSpec`:

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
