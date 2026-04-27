import type { PgClient, DbConfig } from "./types.js";
import { createPgliteClient } from "./pglite-adapter.js";
import { createBunSqlClient } from "./bun-sql-adapter.js";
import { createPostgresJsClient } from "./postgres-js-adapter.js";

/**
 * Driver selection for `kind: "postgres"`:
 * - `PG_DRIVER=postgres-js` → porsager/postgres (Node.js, more battle-tested)
 * - default                 → Bun.SQL (faster but has a Promise-resolution
 *   race under heavy `Promise.all` fan-out — see watchdog code path)
 */
export async function createPgClient(config: DbConfig): Promise<PgClient> {
    if (config.kind === "pglite") {
        return createPgliteClient(config.dataDir);
    }
    const driver = process.env.PG_DRIVER ?? "bun-sql";
    if (driver === "postgres-js") {
        return createPostgresJsClient(config);
    }
    return createBunSqlClient(config);
}
