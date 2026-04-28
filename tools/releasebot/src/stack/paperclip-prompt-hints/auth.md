## Paperclip — auth model

The stack boots in `local_trusted` deployment mode with no sign-in. Do NOT generate login steps; navigate directly to authenticated routes.

If the runner provides a pre-authenticated browser context (storage state cookie), the harness will mention it explicitly in the per-PR context — only then should you write your plan against an already-signed-in session. By default, assume no auth flow is needed.
