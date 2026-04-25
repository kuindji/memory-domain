import type { PgClient, DbConfig } from "./types.js";

/**
 * Minimal subset of `Bun.SQL` we rely on. Typed locally so we don't depend on
 * @types/bun being present at adapter compile time. Bun's SQL is a tagged
 * template literal callable that also has methods on it.
 */
type BunSqlTag = {
    <T = Record<string, unknown>>(strings: TemplateStringsArray, ...params: unknown[]): Promise<T[]>;
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

class BunSqlClient implements PgClient {
    private closed = false;

    constructor(
        private sql: BunSqlTag,
        private isTransaction: boolean,
        private owns: boolean,
    ) {}

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        return this.sql.unsafe<T>(sql, params.map(encodeParam));
    }

    async run(sql: string): Promise<void> {
        await this.sql.unsafe(sql);
    }

    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
        if (this.isTransaction) {
            return fn(this);
        }
        return this.sql.begin(async (tx) => fn(new BunSqlClient(tx, true, false)));
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
    const sql = new SQL(options);
    return new BunSqlClient(sql, false, true);
}
