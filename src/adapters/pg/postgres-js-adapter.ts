import postgres from "postgres";
import type { PgClient, DbConfig } from "./types.js";
import { JsonbParam } from "./types.js";

type Sql = ReturnType<typeof postgres>;

class PostgresJsClient implements PgClient {
    private closed = false;

    constructor(
        private sql: Sql,
        private isTransaction: boolean,
        private owns: boolean,
    ) {}

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        const encoded = params.map(encodeParam) as Parameters<Sql["unsafe"]>[1];
        const rows = await this.sql.unsafe<T[]>(sql, encoded);
        return rows as unknown as T[];
    }

    async run(sql: string): Promise<void> {
        await this.sql.unsafe(sql);
    }

    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
        if (this.isTransaction) return fn(this);
        return this.sql.begin(async (tx) =>
            fn(new PostgresJsClient(tx as unknown as Sql, true, false)),
        ) as Promise<T>;
    }

    async close(): Promise<void> {
        if (this.closed || !this.owns) return;
        this.closed = true;
        await this.sql.end({ timeout: 5 });
    }
}

/**
 * Mirrors the BunSqlAdapter encodeParam: PG text-array literals for plain JS
 * arrays (so call sites can bind against `::text[]`/`::int[]` casts), and
 * JSON-stringify for jsonb (postgres.js does not auto-serialize objects when
 * using `unsafe` with positional params).
 */
function encodeParam(value: unknown): unknown {
    if (value instanceof JsonbParam) {
        const v = value.value;
        if (v === null || v === undefined) return null;
        return JSON.stringify(v);
    }
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !ArrayBuffer.isView(value)) {
        // Plain objects bound to jsonb columns — stringify so postgres.js sends
        // them as text, then PG casts via the column type / explicit ::jsonb.
        return JSON.stringify(value);
    }
    if (!Array.isArray(value)) return value;
    const parts = value.map((el) => {
        if (el === null || el === undefined) return "NULL";
        if (typeof el === "number" || typeof el === "boolean") return String(el);
        const s = String(el);
        return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    });
    return `{${parts.join(",")}}`;
}

export function createPostgresJsClient(config: Extract<DbConfig, { kind: "postgres" }>): PgClient {
    const opts: Parameters<typeof postgres>[1] = {
        prepare: false,
        max: config.max ?? 10,
        idle_timeout: config.idleTimeout,
        connect_timeout: 30,
        // postgres.js exposes per-statement timeout via `statement_timeout`
        // (server-side). We pass our queryTimeoutMs as a hint; rely on the
        // server to enforce. Set 0 to disable.
        ...(config.queryTimeoutMs && config.queryTimeoutMs > 0
            ? { statement_timeout: config.queryTimeoutMs }
            : {}),
    };
    if (config.ssl !== undefined) opts.ssl = config.ssl as never;
    const sql = postgres(config.url, opts);
    return new PostgresJsClient(sql, false, true);
}
