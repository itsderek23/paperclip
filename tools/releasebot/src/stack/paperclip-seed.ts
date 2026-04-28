import fs from "node:fs/promises";
import path from "node:path";
import type {
  FixtureSpec,
  FixtureSpecDrizzleInsertEntity,
  FixtureSpecEntity,
  FixtureSpecHttpEntity,
  FixtureSpecSqlEntity,
  FixtureSummary,
} from "../types.ts";
import type { DbContext } from "./db.ts";

export const AVAILABLE_ENDPOINTS = `
Available write endpoints (local_trusted, no auth required). Use ONLY these — other paths return 404 or require approval flows.

  POST /api/companies
    body: { name: string }
    response: { id: string, ... }
    Capture: id (always).

  POST /api/companies/:companyId/issues
    body: {
      title: string,
      description?: string,
      blockedByIssueIds?: string[],      // array of UUIDs of blocker issues
      parentId?: string,                  // UUID of parent issue (NOT "parentIssueId")
    }
    response: { id: string, identifier: string, ... }
    Capture: id AND identifier. URLs use the identifier: /issues/<identifier>.
    Unknown fields are silently dropped — use EXACTLY these names.

  POST /api/issues/:issueId/comments
    body: { body: string }
    response: { id: string }
    Capture: id.

DO NOT attempt agent creation — it requires a hire/approval flow that can't complete synchronously. Do not use any other endpoints.

Template references: use {{name.field}} to interpolate a captured value into a later entity — e.g. "companyId": "{{company.id}}" (though note companyId is in the URL path for issues, not the body).
`;

export async function executeFixtureSpec(args: {
  baseUrl: string;
  spec: FixtureSpec;
  artifactsDir: string;
  sideLabel: string;
}): Promise<FixtureSummary> {
  const { baseUrl, spec, artifactsDir, sideLabel } = args;
  const summary = await executeSpec(baseUrl, spec);
  await fs.writeFile(path.join(artifactsDir, `fixtures.${sideLabel}.json`), JSON.stringify(summary, null, 2));
  return summary;
}

export async function executeSpec(
  baseUrl: string,
  spec: FixtureSpec,
  initialSummary?: FixtureSummary,
  dbCtx?: DbContext,
): Promise<FixtureSummary> {
  const summary: FixtureSummary = initialSummary ? { ...initialSummary } : {};
  for (const entity of spec.entities) {
    try {
      const kind = entity.kind ?? "http";
      if (kind === "http") {
        await runHttpEntity(baseUrl, entity as FixtureSpecHttpEntity, summary);
      } else if (kind === "sql") {
        await runSqlEntity(entity as FixtureSpecSqlEntity, summary, dbCtx);
      } else if (kind === "drizzle-insert") {
        await runDrizzleInsertEntity(entity as FixtureSpecDrizzleInsertEntity, summary, dbCtx);
      } else {
        summary[entity.name] = { values: {}, note: `unknown kind: ${String(kind)}` };
      }
    } catch (err) {
      summary[entity.name] = { values: {}, note: `error: ${(err as Error).message}` };
    }
  }
  return summary;
}

async function runHttpEntity(
  baseUrl: string,
  entity: FixtureSpecHttpEntity,
  summary: FixtureSummary,
): Promise<void> {
  const endpoint = interpolate(entity.endpoint, summary);
  const body = interpolateObject(entity.body, summary);
  const { method, url } = parseEndpoint(endpoint);
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    summary[entity.name] = { values: {}, note: `HTTP ${res.status} from ${method} ${url}: ${(await res.text()).slice(0, 200)}` };
    return;
  }
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const values = capture(entity, payload);
  // Also carry through a few body fields the planner LLM needs to write
  // exact locators against: title/name. Avoids forcing the seed LLM to
  // remember to capture them, and prevents the planner from hallucinating
  // titles when writing expect(locator).toHaveText(...) / aria-label matches.
  const bodyObj = body as Record<string, unknown>;
  for (const key of ["title", "name"]) {
    if (!(key in values) && typeof bodyObj[key] === "string") {
      values[key] = bodyObj[key] as string;
    }
  }
  // Relationship annotations — the planner needs to know which issue blocks
  // which and which has a parent, so it can pick a URL that actually exercises
  // the feature under test.
  const note = formatRelationships(bodyObj, summary);
  summary[entity.name] = note ? { values, note } : { values };
}

async function runSqlEntity(
  entity: FixtureSpecSqlEntity,
  summary: FixtureSummary,
  dbCtx: DbContext | undefined,
): Promise<void> {
  if (!dbCtx) {
    summary[entity.name] = { values: {}, note: "no db context — sql entity skipped" };
    return;
  }
  const query = interpolate(entity.query, summary);
  const params = (entity.params ?? []).map((p) =>
    typeof p === "string" ? interpolate(p, summary) : p,
  );
  const rows = (await dbCtx.sql.unsafe(query, params as never[])) as unknown as Record<string, unknown>[];
  const first = rows[0] ?? {};
  summary[entity.name] = { values: capture(entity, first) };
}

async function runDrizzleInsertEntity(
  entity: FixtureSpecDrizzleInsertEntity,
  summary: FixtureSummary,
  dbCtx: DbContext | undefined,
): Promise<void> {
  if (!dbCtx) {
    summary[entity.name] = { values: {}, note: "no db context — drizzle-insert entity skipped" };
    return;
  }
  const interpolated = interpolateObject(entity.values, summary) as
    | Record<string, unknown>
    | Record<string, unknown>[];
  const rows = (Array.isArray(interpolated) ? interpolated : [interpolated]).map((row) =>
    coerceTimestampStrings(row as Record<string, unknown>),
  );
  if (rows.length === 0) {
    summary[entity.name] = { values: {}, note: "drizzle-insert entity has no rows" };
    return;
  }
  const cols = Object.keys(rows[0]);
  if (cols.length === 0) {
    summary[entity.name] = { values: {}, note: "drizzle-insert entity has no columns" };
    return;
  }
  const captureFields = entity.capture
    ? Object.values(entity.capture)
        .map((p) => p.match(/^\$\.(.+)$/)?.[1])
        .filter((f): f is string => !!f)
    : ["id"];
  const colList = cols.map(quoteIdent).join(", ");
  const valuesPlaceholders = rows
    .map((_, rowIdx) => `(${cols.map((_, colIdx) => `$${rowIdx * cols.length + colIdx + 1}`).join(", ")})`)
    .join(", ");
  const params: unknown[] = [];
  for (const row of rows) {
    for (const c of cols) params.push(row[c] ?? null);
  }
  const returnList = captureFields.length > 0 ? captureFields.map(quoteIdent).join(", ") : "*";
  const sqlText = `INSERT INTO ${quoteIdent(entity.table)} (${colList}) VALUES ${valuesPlaceholders} RETURNING ${returnList}`;
  const result = (await dbCtx.sql.unsafe(sqlText, params as never[])) as unknown as Record<string, unknown>[];
  const first = result[0] ?? {};
  summary[entity.name] = { values: capture(entity, first) };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function coerceTimestampStrings(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && ISO_TIMESTAMP_RE.test(v)) {
      const d = new Date(v);
      out[k] = Number.isNaN(d.getTime()) ? v : d;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseEndpoint(s: string): { method: string; url: string } {
  const m = s.match(/^([A-Z]+)\s+(.+)$/);
  if (!m) throw new Error(`Bad endpoint: ${s}`);
  return { method: m[1], url: m[2] };
}

function formatRelationships(body: Record<string, unknown>, summary: FixtureSummary): string | undefined {
  const parts: string[] = [];
  const parentId = typeof body.parentId === "string" ? body.parentId : undefined;
  if (parentId) {
    const parent = resolveIdentifier(summary, parentId);
    if (parent) parts.push(`parent=${parent}`);
  }
  const blockedByIds = Array.isArray(body.blockedByIssueIds)
    ? (body.blockedByIssueIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (blockedByIds.length > 0) {
    const idents = blockedByIds.map((id) => resolveIdentifier(summary, id)).filter(Boolean);
    if (idents.length > 0) parts.push(`blockedBy=[${idents.join(",")}]`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function resolveIdentifier(summary: FixtureSummary, id: string): string | undefined {
  for (const entry of Object.values(summary)) {
    if (entry.values.id === id) return entry.values.identifier ?? entry.values.id;
  }
  return undefined;
}

function capture(entity: FixtureSpecEntity, payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const caps = entity.capture ?? { id: "$.id" };
  for (const [key, path] of Object.entries(caps)) {
    const m = path.match(/^\$\.(.+)$/);
    if (!m) continue;
    const field = m[1];
    const val = payload[field];
    if (val != null) out[key] = String(val);
  }
  return out;
}

function interpolateObject(obj: unknown, summary: FixtureSummary): unknown {
  if (obj == null) return obj;
  if (typeof obj === "string") return interpolate(obj, summary);
  if (Array.isArray(obj)) return obj.map((v) => interpolateObject(v, summary));
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = interpolateObject(v, summary);
    return out;
  }
  return obj;
}

function interpolate(s: string, summary: FixtureSummary): string {
  return s.replace(/\{\{([^}]+?)\}\}/g, (_, expr) => {
    const [name, field] = String(expr).trim().split(".");
    return summary[name]?.values[field] ?? "";
  });
}
