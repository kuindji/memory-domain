import { describe, test, expect } from "bun:test";
import { createPgliteClient } from "../src/adapters/pg/pglite-adapter.js";

describe("PgliteAdapter", () => {
    test("query/run/transaction round-trip", async () => {
        const db = await createPgliteClient();
        try {
            await db.run(`
                CREATE TABLE thing (
                    id text PRIMARY KEY,
                    value int NOT NULL
                );
            `);

            await db.query("INSERT INTO thing (id, value) VALUES ($1, $2)", ["a", 1]);
            await db.query("INSERT INTO thing (id, value) VALUES ($1, $2)", ["b", 2]);

            const rows = await db.query<{ id: string; value: number }>(
                "SELECT id, value FROM thing ORDER BY id",
            );
            expect(rows).toHaveLength(2);
            expect(rows[0]).toEqual({ id: "a", value: 1 });
            expect(rows[1]).toEqual({ id: "b", value: 2 });
        } finally {
            await db.close();
        }
    });

    test("transaction commit", async () => {
        const db = await createPgliteClient();
        try {
            await db.run("CREATE TABLE t (id text PRIMARY KEY)");
            await db.transaction(async (tx) => {
                await tx.query("INSERT INTO t (id) VALUES ($1)", ["x"]);
                await tx.query("INSERT INTO t (id) VALUES ($1)", ["y"]);
            });
            const rows = await db.query<{ id: string }>("SELECT id FROM t ORDER BY id");
            expect(rows.map((r) => r.id)).toEqual(["x", "y"]);
        } finally {
            await db.close();
        }
    });

    test("transaction rollback on throw", async () => {
        const db = await createPgliteClient();
        try {
            await db.run("CREATE TABLE t (id text PRIMARY KEY)");
            await db.query("INSERT INTO t (id) VALUES ($1)", ["seed"]);

            await expect(
                db.transaction(async (tx) => {
                    await tx.query("INSERT INTO t (id) VALUES ($1)", ["doomed"]);
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            const rows = await db.query<{ id: string }>("SELECT id FROM t ORDER BY id");
            expect(rows.map((r) => r.id)).toEqual(["seed"]);
        } finally {
            await db.close();
        }
    });

    test("pgvector extension works", async () => {
        const db = await createPgliteClient();
        try {
            await db.run(`
                CREATE TABLE items (
                    id text PRIMARY KEY,
                    embedding vector(3)
                );
            `);
            await db.query("INSERT INTO items (id, embedding) VALUES ($1, $2)", [
                "a",
                "[1,0,0]",
            ]);
            await db.query("INSERT INTO items (id, embedding) VALUES ($1, $2)", [
                "b",
                "[0,1,0]",
            ]);
            await db.query("INSERT INTO items (id, embedding) VALUES ($1, $2)", [
                "c",
                "[0.9,0.1,0]",
            ]);

            const rows = await db.query<{ id: string; distance: number }>(
                `SELECT id, embedding <=> $1::vector AS distance
                 FROM items ORDER BY distance ASC LIMIT 2`,
                ["[1,0,0]"],
            );
            expect(rows[0].id).toBe("a");
            expect(rows[1].id).toBe("c");
        } finally {
            await db.close();
        }
    });
});
