## Paperclip — available write endpoints

You may seed fixtures via these endpoints only. They run under `local_trusted` deployment mode (no auth headers required). Other paths return 404, require an approval flow that can't complete synchronously, or both — do not attempt them.

```
POST /api/companies
  body: { name: string }
  response: { id: string, ... }
  Capture: id (always).

POST /api/companies/:companyId/issues
  body: {
    title: string,
    description?: string,
    blockedByIssueIds?: string[],   // array of UUIDs of blocker issues
    parentId?: string,               // UUID of parent issue (NOT "parentIssueId")
  }
  response: { id: string, identifier: string, ... }
  Capture: id AND identifier. URLs use the identifier: /issues/<identifier>.
  Unknown fields are silently dropped — use EXACTLY these names.

POST /api/issues/:issueId/comments
  body: { body: string }
  response: { id: string }
  Capture: id.
```

Do NOT attempt agent creation — it requires a hire/approval flow that can't complete synchronously.

Template references: use `{{name.field}}` to interpolate a captured value into a later entity — e.g. `"companyId": "{{company.id}}"`. Note that for issues, `companyId` is in the URL path, not the body.

If you need runtime-gated state (a stalled heartbeat run, a scheduled retry, a watchdog threshold) that no public endpoint produces, emit a `kind: "sql"` fixture entity with a raw INSERT against the embedded postgres. Do NOT attempt to synthesize this state via UI flows.
