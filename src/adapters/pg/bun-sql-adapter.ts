import type { PgClient, DbConfig } from "./types.js";
import { JsonbParam } from "./types.js";

/**
 * Minimal subset of `Bun.SQL` we rely on. Typed locally so we don't depend on
 * @types/bun being present at adapter compile time. Bun's SQL is a tagged
 * template literal callable that also has methods on it.
 */
type BunSqlTag = {
    <T = Record<string, unknown>>(
        strings: TemplateStringsArray,
        ...params: unknown[]
    ): Promise<T[]>;
    unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
    begin<T>(fn: (tx: BunSqlTag) => Promise<T>): Promise<T>;
    end(): Promise<void>;
    close?: () => Promise<void>;
};

type BunSqlConstructor = new (urlOrOptions: string | Record<string, unknown>) => BunSqlTag;

type BunNamespace = {
    SQL: BunSqlConstructor;
};

function getBunSql(): BunSqlConstructor {
    const bun = (globalThis as { Bun?: BunNamespace }).Bun;
    if (!bun?.SQL) {
        throw new Error(
            "Bun.SQL is not available. The 'postgres' adapter requires the Bun runtime.",
        );
    }
    return bun.SQL;
}

type BunSqlClientOpts = {
    /** Per-query watchdog (ms). 0 disables the watchdog. */
    queryTimeoutMs: number;
    /** Retries on watchdog timeout (so total attempts = retries + 1). */
    queryRetries: number;
};

const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_QUERY_RETRIES = 2;

export class BunSqlQueryTimeoutError extends Error {
    constructor(
        public sql: string,
        public elapsedMs: number,
    ) {
        super(`Bun.SQL query exceeded watchdog (${elapsedMs}ms): ${sql.slice(0, 200)}`);
        this.name = "BunSqlQueryTimeoutError";
    }
}

/**
 * Runs `op` under a watchdog timer. If the Promise doesn't settle inside
 * `timeoutMs`, retries up to `retries` times before rejecting with
 * `BunSqlQueryTimeoutError`. Set `allowRetry=false` for transactions —
 * re-issuing inside an aborted tx would target a different connection
 * and the original tx state is unrecoverable.
 *
 * Exported so it can be unit-tested without standing up a Bun.SQL pool.
 */
export async function runQueryWithWatchdog<T>(
    sql: string,
    op: () => Promise<unknown[]>,
    timeoutMs: number,
    retries: number,
    allowRetry: boolean,
): Promise<T[]> {
    if (timeoutMs <= 0) return op() as Promise<T[]>;

    const maxAttempts = allowRetry ? retries + 1 : 1;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const start = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await new Promise<unknown[]>((resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new BunSqlQueryTimeoutError(sql, Date.now() - start));
                }, timeoutMs);
                op().then(resolve, reject);
            });
            return result as T[];
        } catch (err) {
            lastErr = err;
            // On retry attempts, a unique-violation almost certainly means
            // the previous attempt's write actually committed before its JS
            // Promise was lost. Treat it as success (return empty rows —
            // none of the framework's INSERT paths consume the result row
            // count beyond "did it throw?").
            if (attempt > 1 && isUniqueViolation(err)) {
                console.warn(
                    `[BunSqlAdapter] retry hit unique_violation, treating as committed: ${sql.slice(0, 120)}`,
                );
                return [] as T[];
            }
            if (!(err instanceof BunSqlQueryTimeoutError)) throw err;
            if (attempt >= maxAttempts) break;
            console.warn(
                `[BunSqlAdapter] query timeout after ${err.elapsedMs}ms, retry ${attempt}/${maxAttempts - 1}: ${sql.slice(0, 120)}`,
            );
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    throw lastErr;
}

function isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { errno?: unknown; code?: unknown };
    return e.errno === "23505" || e.code === "23505";
}

class BunSqlClient implements PgClient {
    private closed = false;

    constructor(
        private sql: BunSqlTag,
        private isTransaction: boolean,
        private owns: boolean,
        private opts: BunSqlClientOpts,
    ) {}

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        const encoded = params.map(encodeParam);
        return runQueryWithWatchdog<T>(
            sql,
            () => this.sql.unsafe<T>(sql, encoded),
            this.opts.queryTimeoutMs,
            this.opts.queryRetries,
            !this.isTransaction,
        );
    }

    async run(sql: string): Promise<void> {
        await runQueryWithWatchdog<unknown>(
            sql,
            () => this.sql.unsafe(sql),
            this.opts.queryTimeoutMs,
            this.opts.queryRetries,
            !this.isTransaction,
        );
    }

    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
        if (this.isTransaction) {
            return fn(this);
        }
        return this.sql.begin(async (tx) => fn(new BunSqlClient(tx, true, false, this.opts)));
    }

    async close(): Promise<void> {
        if (this.closed || !this.owns) return;
        this.closed = true;
        const closer = this.sql.close ?? this.sql.end.bind(this.sql);
        await closer.call(this.sql);
    }
}

/**
 * Bun.SQL's `unsafe(sql, params)` does not serialize JS arrays into Postgres
 * array literals — it falls back to `Array.toString()` which yields a comma-
 * joined string, which Postgres then rejects with "malformed array literal".
 * We pre-format arrays of primitives into the `{val1,val2}` syntax Postgres
 * expects so call sites can pass plain JS arrays bound against `::text[]`,
 * `::int[]`, etc.
 *
 * Strings are double-quoted with `"` and `\` backslash-escaped. NULL elements
 * become the literal `NULL`. Nested arrays are not supported (no caller needs
 * them yet).
 */
function encodeParam(value: unknown): unknown {
    // JsonbParam opts out: Bun.SQL serializes JS objects/arrays to JSONB
    // natively, and pre-formatting as a PG text-array literal would corrupt
    // them (the inner objects would `String()` to "[object Object]").
    if (value instanceof JsonbParam) return value.value;
    if (!Array.isArray(value)) return value;
    const parts = value.map((el) => {
        if (el === null || el === undefined) return "NULL";
        if (typeof el === "number" || typeof el === "boolean") return String(el);
        const s = String(el);
        return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    });
    return `{${parts.join(",")}}`;
}

export function createBunSqlClient(config: Extract<DbConfig, { kind: "postgres" }>): PgClient {
    const SQL = getBunSql();
    const options: Record<string, unknown> = { url: config.url };
    if (config.ssl !== undefined) options.tls = config.ssl;
    // Only override pool defaults when the caller asked us to. Bun.SQL's
    // idleTimeout closes pooled connections mid-workload when set, which
    // breaks the long-running ingest path.
    if (config.max !== undefined) options.max = config.max;
    if (config.idleTimeout !== undefined) options.idleTimeout = config.idleTimeout;
    const sql = new SQL(options);
    const opts: BunSqlClientOpts = {
        queryTimeoutMs: config.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
        queryRetries: config.queryRetries ?? DEFAULT_QUERY_RETRIES,
    };
    return new BunSqlClient(sql, false, true, opts);
}
