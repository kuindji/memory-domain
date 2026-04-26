import { randomUUID } from "node:crypto";
import type { PgClient } from "../adapters/pg/types.js";
import { JsonbParam } from "../adapters/pg/types.js";
import type { Edge, GraphApi, Node } from "./types.js";

/**
 * Lookup hook the engine plugs in so GraphStore knows which columns are jsonb.
 * When unset (e.g. unit tests with raw GraphStore), all columns are treated as
 * non-jsonb — same behavior as before this fix.
 */
type JsonbLookup = (table: string, column: string) => boolean;

/**
 * Postgres-backed graph store. Ids retain the SurrealDB-era `<table>:<uuid>`
 * shape so callers don't change. Edges live in dedicated tables with
 * `id text PRIMARY KEY`, `in_id text NOT NULL`, `out_id text NOT NULL`.
 *
 * Object/array values in `data` payloads are JSON-stringified before binding so
 * jsonb and vector columns receive a textual representation Postgres can
 * coerce. Number primitives, strings, booleans and null pass through unchanged.
 */

const TABLE_FROM_ID = (id: string): string => {
    const i = id.indexOf(":");
    if (i <= 0) {
        throw new Error(`Invalid record id (expected '<table>:<uuid>'): ${id}`);
    }
    return id.slice(0, i);
};

function newRecordId(table: string): string {
    return `${table}:${randomUUID()}`;
}

function bindValue(value: unknown, jsonb: boolean): unknown {
    if (value === null || value === undefined) return null;
    if (jsonb) {
        // JSONB columns: hand the raw object/array (or scalar) off to the
        // adapter wrapped in JsonbParam. Bun.SQL serializes JS objects to
        // jsonb natively; pre-stringifying causes Bun.SQL to JSON-encode the
        // string AGAIN, leaving a quoted string literal in the jsonb cell
        // (the silent corruption that broke conflict-topic-linking and
        // owned_by.attributes after the SurrealDB→Postgres migration). PGLite
        // unwraps and JSON.stringifies in its adapter to match its own
        // binding contract.
        return new JsonbParam(value);
    }
    if (typeof value === "object") return JSON.stringify(value);
    return value;
}

interface InsertParts {
    columns: string[];
    placeholders: string[];
    values: unknown[];
}

function buildInsert(
    table: string,
    idColValue: string,
    data: Record<string, unknown>,
    isJsonb: JsonbLookup,
): InsertParts {
    const columns = ["id"];
    const placeholders = ["$1"];
    const values: unknown[] = [idColValue];
    let i = 2;
    for (const [k, v] of Object.entries(data)) {
        if (v === undefined) continue;
        columns.push(k);
        placeholders.push(`$${i}`);
        values.push(bindValue(v, isJsonb(table, k)));
        i++;
    }
    return { columns, placeholders, values };
}

interface UpdateParts {
    sets: string[];
    values: unknown[];
}

function buildUpdate(
    table: string,
    data: Record<string, unknown>,
    paramOffset: number,
    isJsonb: JsonbLookup,
): UpdateParts {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = paramOffset;
    for (const [k, v] of Object.entries(data)) {
        if (v === undefined) continue;
        sets.push(`${k} = $${i}`);
        values.push(bindValue(v, isJsonb(table, k)));
        i++;
    }
    return { sets, values };
}

class GraphStore implements GraphApi {
    private isJsonb: JsonbLookup;

    constructor(private db: PgClient, isJsonb?: JsonbLookup) {
        this.isJsonb = isJsonb ?? (() => false);
    }

    async createNode(table: string, data: Record<string, unknown>): Promise<string> {
        const id = newRecordId(table);
        return this.createNodeWithId(id, data);
    }

    async createNodeWithId(id: string, data: Record<string, unknown>): Promise<string> {
        const table = TABLE_FROM_ID(id);
        const { columns, placeholders, values } = buildInsert(table, id, data, this.isJsonb);
        await this.db.query(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
            values,
        );
        return id;
    }

    async getNode<T extends Node = Node>(id: string): Promise<T | null> {
        const table = TABLE_FROM_ID(id);
        const rows = await this.db.query<T>(`SELECT * FROM ${table} WHERE id = $1`, [id]);
        return rows[0] ?? null;
    }

    async getNodes<T extends Node = Node>(ids: string[]): Promise<T[]> {
        if (ids.length === 0) return [];
        // Group by table so we can issue one query per table.
        const byTable = new Map<string, string[]>();
        for (const id of ids) {
            const t = TABLE_FROM_ID(id);
            const arr = byTable.get(t);
            if (arr) arr.push(id);
            else byTable.set(t, [id]);
        }
        const out: T[] = [];
        for (const [table, group] of byTable) {
            const rows = await this.db.query<T>(
                `SELECT * FROM ${table} WHERE id = ANY($1::text[])`,
                [group],
            );
            out.push(...rows);
        }
        return out;
    }

    async updateNode(id: string, data: Record<string, unknown>): Promise<void> {
        const table = TABLE_FROM_ID(id);
        const { sets, values } = buildUpdate(table, data, 2, this.isJsonb);
        if (sets.length === 0) return;
        await this.db.query(
            `UPDATE ${table} SET ${sets.join(", ")} WHERE id = $1`,
            [id, ...values],
        );
    }

    async deleteNode(id: string): Promise<boolean> {
        const table = TABLE_FROM_ID(id);
        const rows = await this.db.query<{ id: string }>(
            `DELETE FROM ${table} WHERE id = $1 RETURNING id`,
            [id],
        );
        return rows.length > 0;
    }

    async deleteNodes(ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        const byTable = new Map<string, string[]>();
        for (const id of ids) {
            const t = TABLE_FROM_ID(id);
            const arr = byTable.get(t);
            if (arr) arr.push(id);
            else byTable.set(t, [id]);
        }
        for (const [table, group] of byTable) {
            await this.db.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [group]);
        }
    }

    async relate(
        from: string,
        edge: string,
        to: string,
        data?: Record<string, unknown>,
    ): Promise<string> {
        const id = `${edge}:${randomUUID()}`;
        const payload: Record<string, unknown> = { in_id: from, out_id: to, ...(data ?? {}) };
        const { columns, placeholders, values } = buildInsert(edge, id, payload, this.isJsonb);
        await this.db.query(
            `INSERT INTO ${edge} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
            values,
        );
        return id;
    }

    async unrelate(from: string, edge: string, to: string): Promise<boolean> {
        const rows = await this.db.query<{ id: string }>(
            `DELETE FROM ${edge} WHERE in_id = $1 AND out_id = $2 RETURNING id`,
            [from, to],
        );
        return rows.length > 0;
    }

    async outgoing<T = Edge>(from: string, edge: string): Promise<T[]> {
        return this.db.query<T>(
            `SELECT id, in_id AS "in", out_id AS "out" FROM ${edge} WHERE in_id = $1`,
            [from],
        );
    }

    async incoming<T = Edge>(to: string, edge: string): Promise<T[]> {
        return this.db.query<T>(
            `SELECT id, in_id AS "in", out_id AS "out" FROM ${edge} WHERE out_id = $1`,
            [to],
        );
    }

    async deleteEdges(
        edge: string,
        where: { in?: string | string[]; out?: string | string[] },
    ): Promise<void> {
        const clauses: string[] = [];
        const values: unknown[] = [];
        let i = 1;
        if (where.in !== undefined) {
            if (Array.isArray(where.in)) {
                clauses.push(`in_id = ANY($${i}::text[])`);
                values.push(where.in);
            } else {
                clauses.push(`in_id = $${i}`);
                values.push(where.in);
            }
            i++;
        }
        if (where.out !== undefined) {
            if (Array.isArray(where.out)) {
                clauses.push(`out_id = ANY($${i}::text[])`);
                values.push(where.out);
            } else {
                clauses.push(`out_id = $${i}`);
                values.push(where.out);
            }
            i++;
        }
        if (clauses.length === 0) return;
        await this.db.query(`DELETE FROM ${edge} WHERE ${clauses.join(" AND ")}`, values);
    }

    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
        return this.db.query<T>(sql, params);
    }

    async run(sql: string): Promise<void> {
        await this.db.run(sql);
    }

    async transaction<T>(fn: (tx: GraphApi) => Promise<T>): Promise<T> {
        return this.db.transaction(async (txDb) => fn(new GraphStore(txDb, this.isJsonb)));
    }
}

export { GraphStore };
