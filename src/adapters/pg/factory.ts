import type { PgClient, DbConfig } from "./types.js";
import { createPgliteClient } from "./pglite-adapter.js";
import { createBunSqlClient } from "./bun-sql-adapter.js";

export async function createPgClient(config: DbConfig): Promise<PgClient> {
    if (config.kind === "pglite") {
        return createPgliteClient(config.dataDir);
    }
    return createBunSqlClient(config);
}
