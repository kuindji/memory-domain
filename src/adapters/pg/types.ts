/**
 * Postgres client abstraction used by graph-store, schema-registry, search-engine,
 * and inbox-processor. Two implementations live alongside this file: PgliteAdapter
 * (embedded WASM Postgres for tests + local) and BunSqlAdapter (Bun.SQL for
 * Docker / managed Postgres).
 */
export interface PgClient {
    /**
     * Run a SQL statement with positional parameters ($1, $2, …) and return
     * result rows. For statements that return no rows (DDL, INSERT without
     * RETURNING, etc.) the result is an empty array.
     */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

    /**
     * Run one or more statements without parameters and discard any result.
     * Used for DDL batches where binding params is not needed.
     */
    run(sql: string): Promise<void>;

    /**
     * Run `fn` inside a transaction. Commits on resolve, rolls back on throw.
     * Nested calls reuse the outer transaction.
     */
    transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T>;

    /** Close the underlying connection / pool. Idempotent. */
    close(): Promise<void>;
}

export type DbConfig =
    | {
          kind: "pglite";
          /** Directory for the on-disk PGLite database. Omit for in-memory. */
          dataDir?: string;
      }
    | {
          kind: "postgres";
          /** Postgres connection URL (postgres://user:pass@host:port/db). */
          url: string;
          /** Enable TLS. `true` for default TLS, an object for fine-grained options. */
          ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
      };
