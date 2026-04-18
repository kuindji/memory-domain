import { Surreal, Table, StringRecordId } from "surrealdb";
import type { SurrealTransaction } from "surrealdb";
import type { Node, GraphApi } from "./types.js";

type Queryable = Surreal | SurrealTransaction;

/**
 * Valid SurrealDB unquoted record-id part (alphanumeric + underscore). Anything
 * else — hyphens, slashes, spaces, dots — must be backtick-escaped or the parser
 * silently truncates at the first invalid char (e.g. `memory:abw-fdi-2001` →
 * `memory:abw`). We escape here at the single chokepoint so every code path
 * that constructs a record id (tag creation, topic memories, domains, meta
 * keys) is safe.
 */
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

function toRecordId(id: string): StringRecordId {
    const colonIdx = id.indexOf(":");
    if (colonIdx > 0) {
        const idPart = id.slice(colonIdx + 1);
        // Already wrapped (backticks or angle brackets) — trust the caller.
        const firstChar = idPart.charCodeAt(0);
        const alreadyWrapped = firstChar === 0x60 /* ` */ || firstChar === 0x27e8; /* ⟨ */
        if (!alreadyWrapped && idPart.length > 0 && !SAFE_IDENT.test(idPart)) {
            const table = id.slice(0, colonIdx);
            return new StringRecordId(`${table}:\`${idPart}\``);
        }
    }
    return new StringRecordId(id);
}

function extractId(obj: { id: unknown }): string {
    return String(obj.id);
}

export class GraphStore implements GraphApi {
    private queryable: Queryable;

    constructor(db: Queryable) {
        this.queryable = db;
    }

    async createNode(type: string, data: Record<string, unknown>): Promise<string> {
        const result = await this.queryable.create(new Table(type)).content(data);
        const arr = result as { id: unknown }[];
        return extractId(arr[0]);
    }

    async createNodeWithId(id: string, data: Record<string, unknown>): Promise<string> {
        const [result] = await this.queryable.query<[{ id: unknown }[]]>(
            "CREATE $id CONTENT $data",
            { id: toRecordId(id), data },
        );
        return extractId(result[0]);
    }

    async getNode<T extends Node = Node>(id: string): Promise<T | null> {
        const result = await this.queryable.select<T>(toRecordId(id));
        if (result === undefined) return null;
        return { ...result, id: extractId(result as { id: unknown }) } as T;
    }

    async updateNode(id: string, data: Record<string, unknown>): Promise<void> {
        await this.queryable.update(toRecordId(id)).merge(data);
    }

    async deleteNode(id: string): Promise<boolean> {
        const result = await this.queryable.delete(toRecordId(id));
        return result !== undefined;
    }

    async relate(
        from: string,
        edge: string,
        to: string,
        data?: Record<string, unknown>,
    ): Promise<string> {
        const result = await this.queryable.relate(
            toRecordId(from),
            new Table(edge),
            toRecordId(to),
            data,
        );
        return extractId(result as { id: unknown });
    }

    async unrelate(from: string, edge: string, to: string): Promise<boolean> {
        await this.queryable.query(`DELETE $from->${edge} WHERE out = $to`, {
            from: toRecordId(from),
            to: toRecordId(to),
        });
        return true;
    }

    async traverse<T = Node>(from: string, pattern: string): Promise<T[]> {
        const [result] = await this.queryable.query<[T[][]]>(`SELECT VALUE ${pattern} FROM $from`, {
            from: toRecordId(from),
        });
        if (!result || result.length === 0) return [];
        // SurrealDB wraps graph traversal results in an outer array (one per matched source record)
        return result[0];
    }

    async query<T = unknown>(surql: string, vars?: Record<string, unknown>): Promise<T> {
        const results = await this.queryable.query<[T]>(surql, vars);
        return results[0];
    }

    async transaction<T>(fn: (tx: GraphApi) => Promise<T>): Promise<T> {
        if (!(this.queryable instanceof Surreal)) {
            throw new Error("Nested transactions are not supported");
        }
        const tx = await this.queryable.beginTransaction();
        const txStore = new GraphStore(tx);
        try {
            const result = await fn(txStore);
            await tx.commit();
            return result;
        } catch (err) {
            await tx.cancel();
            throw err;
        }
    }
}
