import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import type { PgClient } from "./types.js";
import { JsonbParam } from "./types.js";

type PgliteHandle = {
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    close?: () => Promise<void>;
} & Record<string, unknown>;

const RUN_METHOD = "exec" as const;
const TX_METHOD = "transaction" as const;

class PgliteClient implements PgClient {
    private closed = false;

    constructor(
        private handle: PgliteHandle,
        private isTransaction: boolean,
        private owns: boolean,
    ) {}

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        // PGLite serializes JS objects/arrays into JSONB natively. Unwrap
        // JsonbParam (used by callers to bypass the BunSqlAdapter's
        // text-array literal formatting) so the raw value reaches PGLite.
        // PGLite needs JSON-serialized strings for JSONB binding, so we
        // stringify here — different from Bun.SQL, which encodes natively.
        const bound = params.map((p) => {
            if (p instanceof JsonbParam) {
                const v = p.value;
                if (v === null || v === undefined) return null;
                return JSON.stringify(v);
            }
            return p;
        });
        const result = await this.handle.query<T>(sql, bound);
        return result.rows;
    }

    async run(sql: string): Promise<void> {
        const fn = this.handle[RUN_METHOD] as (q: string) => Promise<unknown>;
        await fn.call(this.handle, sql);
    }

    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
        if (this.isTransaction) {
            return fn(this);
        }
        const txFn = this.handle[TX_METHOD] as (
            cb: (tx: PgliteHandle) => Promise<T>,
        ) => Promise<T>;
        return txFn.call(this.handle, async (tx: PgliteHandle) =>
            fn(new PgliteClient(tx, true, false)),
        );
    }

    async close(): Promise<void> {
        if (this.closed || !this.owns) return;
        this.closed = true;
        await this.handle.close?.();
    }
}

export async function createPgliteClient(dataDir?: string): Promise<PgClient> {
    const db = await PGlite.create({
        dataDir,
        extensions: { vector },
    });
    const handle = db as unknown as PgliteHandle;
    const runFn = handle[RUN_METHOD] as (q: string) => Promise<unknown>;
    await runFn.call(handle, "CREATE EXTENSION IF NOT EXISTS vector");
    return new PgliteClient(handle, false, true);
}
