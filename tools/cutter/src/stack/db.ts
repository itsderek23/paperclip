import path from "node:path";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

export interface DbContext {
  sql: postgres.Sql;
  close: () => Promise<void>;
}

const PORT_SCAN_RANGE = 30;

export async function openInstanceDb(args: {
  paperclipHome: string;
  instanceId: string;
}): Promise<DbContext> {
  const instanceDir = path.join(args.paperclipHome, "instances", args.instanceId);
  const configPath = path.join(instanceDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    database?: { embeddedPostgresPort?: number; embeddedPostgresDataDir?: string };
  };
  const configuredPort = config.database?.embeddedPostgresPort;
  if (!Number.isInteger(configuredPort) || !configuredPort || configuredPort <= 0) {
    throw new Error(`No embeddedPostgresPort in ${configPath}`);
  }
  const expectedDataDir = path.resolve(
    config.database?.embeddedPostgresDataDir ?? path.join(instanceDir, "db"),
  );

  // The configured port may be stale — paperclip's runtime detectPort() picks a
  // different port when the configured one is busy, but doesn't persist that
  // change back to config.json. Scan a small range starting from the configured
  // port, confirming the postgres at each port owns the expected data dir.
  let lastError: unknown;
  for (let offset = 0; offset < PORT_SCAN_RANGE; offset++) {
    const port = configuredPort + offset;
    const url = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    const sql = postgres(url, { max: 1, connect_timeout: 2, idle_timeout: 2 });
    try {
      const rows = await sql<{ data_directory: string }[]>`SELECT current_setting('data_directory') AS data_directory`;
      const actualDataDir = path.resolve(rows[0]?.data_directory ?? "");
      if (actualDataDir === expectedDataDir) {
        await sql.end({ timeout: 1 });
        const fullSql = postgres(url);
        return { sql: fullSql, close: () => fullSql.end({ timeout: 5 }) };
      }
      await sql.end({ timeout: 1 });
    } catch (err) {
      lastError = err;
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }
  throw new Error(
    `Could not find embedded postgres for ${args.instanceId} (expected dataDir=${expectedDataDir}, scanned ports ${configuredPort}-${configuredPort + PORT_SCAN_RANGE - 1}). Last error: ${(lastError as Error)?.message ?? "(none)"}`,
  );
}
