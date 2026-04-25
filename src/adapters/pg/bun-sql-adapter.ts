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
        return this.sql.unsafe<T>(sql, params);
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

export function createBunSqlClient(config: Extract<DbConfig, { kind: "postgres" }>): PgClient {
    const SQL = getBunSql();
    const options: Record<string, unknown> = { url: config.url };
    if (config.ssl !== undefined) options.tls = config.ssl;
    const sql = new SQL(options);
    return new BunSqlClient(sql, false, true);
}
