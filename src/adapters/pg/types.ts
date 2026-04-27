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

/**
 * Marker that opts a parameter out of the BunSqlAdapter's PG-array-literal
 * encoding. Use it whenever the value's column is jsonb — Bun.SQL serializes
 * JS objects and arrays to JSONB natively, so the adapter must NOT pre-format
 * them as `{a,b}` text-array literals (which would otherwise be required for
 * `::text[]` IN-clauses). The PGLite adapter ignores the wrapper.
 */
export class JsonbParam {
    constructor(public readonly value: unknown) {}
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
          /** Max pool size passed to Bun.SQL. Omit to use Bun's default. */
          max?: number;
          /**
           * Idle connection timeout (seconds) passed to Bun.SQL. Omit to use
           * Bun's default. Note: setting this can break long-running batch
           * workloads (Bun closes pooled connections mid-flight on timeout).
           */
          idleTimeout?: number;
          /**
           * Per-query watchdog timeout in milliseconds. If the underlying
           * `Bun.SQL.unsafe` Promise does not settle within this window the
           * client rejects with a `BunSqlQueryTimeoutError` and (if retries
           * remain) re-issues the same statement. Defaults to 60000ms.
           * Set to 0 to disable the watchdog.
           */
          queryTimeoutMs?: number;
          /**
           * How many times to retry a query that hits the watchdog timeout
           * before bubbling the error. Defaults to 2 (so up to 3 attempts).
           */
          queryRetries?: number;
      };
