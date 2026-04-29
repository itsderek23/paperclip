## Paperclip — URL conventions

The Paperclip UI is a React app rooted at `ui/src/App.tsx`. Read the `<Route path>` tree there before authoring `page.goto(...)` calls — some segments are nested under a `:companyPrefix` parameter and a generated URL that doesn't start with a known top-level segment will fall through to a catch-all 404.

- Issue URLs are identifier-based: `/issues/<identifier>` where `identifier` is captured from `POST /api/companies/:companyId/issues`. Do NOT pass a UUID, a company id, or an invented short code.
- Reference / settings / design-guide routes may live under a company-prefix segment. Verify the actual path in `ui/src/App.tsx` rather than assuming the URL the diff appears to introduce is the full route.
- Use ONLY relative URLs in `page.goto(...)`. The harness injects `baseURL`.

When a step needs an issue URL, use `/issues/<identifier>` with an identifier captured from the seed. If no suitable fixture exists, target a list / index surface instead — never invent an id or use a company id as an issue id.
