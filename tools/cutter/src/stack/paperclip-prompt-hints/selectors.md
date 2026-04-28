## Paperclip — selector & schema conventions

When picking selectors for `markAnnotations(...)` and assertions, prefer (in order):

1. `data-testid="..."` attributes already present in the changed component
2. ARIA roles + accessible names: `getByRole("button", { name: "..." })`, `getByLabel("...")`
3. New literal copy the PR introduces: `getByText("...")`
4. Stable structural selectors scoped to a container: `[data-testid="issue-properties"] a`

Do NOT use brittle CSS paths or generic page chrome (navbar links, the app heading, route `/`). The diff doesn't touch those — they're not a PR signal.

### Where Zod request schemas live

Paperclip request validators live at `packages/shared/src/validators/*.ts`. When a diff adds or modifies a write endpoint, read the corresponding validator there to confirm the exact field names — unknown fields are silently dropped by the server, so a typo in your `seedExtension` body will produce a 200 but no real entity.

### Tests as authoring hints

Adjacent `*.test.tsx` files next to a changed component show how that UI is normally populated in unit tests — they're the cheapest source of "what shape does this component expect from props/fixtures."
