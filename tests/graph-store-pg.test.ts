import { describe, test, expect } from "bun:test";
import { createPgliteClient } from "../src/adapters/pg/pglite-adapter.js";
import { SchemaRegistry } from "../src/core/schema-registry.js";
import { GraphStore } from "../src/core/graph-store.js";

async function setup() {
    const db = await createPgliteClient();
    const reg = new SchemaRegistry(db);
    await reg.registerCore(4);
    return { db, graph: new GraphStore(db) };
}

describe("GraphStore over Postgres", () => {
    test("createNode + getNode", async () => {
        const { db, graph } = await setup();
        try {
            const id = await graph.createNode("memory", {
                content: "hello",
                created_at: 1000,
                token_count: 5,
                metadata: { source: "test" },
            });
            expect(id).toMatch(/^memory:[0-9a-f-]+$/);
            const got = await graph.getNode<{
                id: string;
                content: string;
                metadata: Record<string, unknown>;
            }>(id);
            expect(got?.content).toBe("hello");
            expect(got?.metadata).toEqual({ source: "test" });
        } finally {
            await db.close();
        }
    });

    test("createNodeWithId fixes the id", async () => {
        const { db, graph } = await setup();
        try {
            const id = await graph.createNodeWithId("tag:hello", {
                label: "hello",
                created_at: 1,
            });
            expect(id).toBe("tag:hello");
            const got = await graph.getNode(id);
            expect(got?.label).toBe("hello");
        } finally {
            await db.close();
        }
    });

    test("getNodes batches by table", async () => {
        const { db, graph } = await setup();
        try {
            await graph.createNodeWithId("tag:a", { label: "a", created_at: 1 });
            await graph.createNodeWithId("tag:b", { label: "b", created_at: 2 });
            await graph.createNodeWithId("domain:x", { name: "x" });
            const nodes = await graph.getNodes(["tag:a", "tag:b", "domain:x", "tag:missing"]);
            expect(nodes).toHaveLength(3);
            const labels = nodes.map((n) => (n.label ?? n.name) as string).sort();
            expect(labels).toEqual(["a", "b", "x"]);
        } finally {
            await db.close();
        }
    });

    test("updateNode merges fields", async () => {
        const { db, graph } = await setup();
        try {
            const id = await graph.createNode("memory", {
                content: "v1",
                created_at: 1,
                token_count: 0,
            });
            await graph.updateNode(id, { content: "v2", structured_data: { k: 1 } });
            const got = await graph.getNode<{ content: string; structured_data: unknown }>(id);
            expect(got?.content).toBe("v2");
            expect(got?.structured_data).toEqual({ k: 1 });
        } finally {
            await db.close();
        }
    });

    test("deleteNode + deleteNodes", async () => {
        const { db, graph } = await setup();
        try {
            const a = await graph.createNode("memory", {
                content: "a",
                created_at: 1,
                token_count: 0,
            });
            const b = await graph.createNode("memory", {
                content: "b",
                created_at: 2,
                token_count: 0,
            });
            const c = await graph.createNode("memory", {
                content: "c",
                created_at: 3,
                token_count: 0,
            });

            expect(await graph.deleteNode(a)).toBe(true);
            expect(await graph.deleteNode(a)).toBe(false);

            await graph.deleteNodes([b, c, "memory:nonexistent"]);
            const remaining = await db.query<{ count: number }>(
                "SELECT COUNT(*)::int AS count FROM memory",
            );
            expect(remaining[0].count).toBe(0);
        } finally {
            await db.close();
        }
    });

    test("relate / unrelate / outgoing / incoming", async () => {
        const { db, graph } = await setup();
        try {
            const m = await graph.createNode("memory", {
                content: "m",
                created_at: 1,
                token_count: 0,
            });
            const t1 = await graph.createNodeWithId("tag:t1", { label: "t1", created_at: 1 });
            const t2 = await graph.createNodeWithId("tag:t2", { label: "t2", created_at: 1 });

            const eId = await graph.relate(m, "tagged", t1);
            expect(eId).toMatch(/^tagged:/);
            await graph.relate(m, "tagged", t2);

            const out = await graph.outgoing(m, "tagged");
            expect(out.map((e) => e.out).sort()).toEqual(["tag:t1", "tag:t2"]);

            const inEdges = await graph.incoming(t1, "tagged");
            expect(inEdges).toHaveLength(1);
            expect(inEdges[0].in).toBe(m);

            const removed = await graph.unrelate(m, "tagged", t1);
            expect(removed).toBe(true);
            const after = await graph.outgoing(m, "tagged");
            expect(after.map((e) => e.out)).toEqual(["tag:t2"]);
        } finally {
            await db.close();
        }
    });

    test("relate stores extra fields", async () => {
        const { db, graph } = await setup();
        try {
            const a = await graph.createNode("memory", {
                content: "a",
                created_at: 1,
                token_count: 0,
            });
            const b = await graph.createNode("memory", {
                content: "b",
                created_at: 2,
                token_count: 0,
            });
            await graph.relate(a, "reinforces", b, { strength: 0.75, detected_at: 99 });
            const rows = await db.query<{ strength: number; detected_at: number }>(
                "SELECT strength, detected_at FROM reinforces WHERE in_id = $1 AND out_id = $2",
                [a, b],
            );
            expect(rows[0].strength).toBeCloseTo(0.75);
            expect(rows[0].detected_at).toBe(99);
        } finally {
            await db.close();
        }
    });

    test("deleteEdges with array filters", async () => {
        const { db, graph } = await setup();
        try {
            const m1 = await graph.createNode("memory", {
                content: "m1",
                created_at: 1,
                token_count: 0,
            });
            const m2 = await graph.createNode("memory", {
                content: "m2",
                created_at: 2,
                token_count: 0,
            });
            const t = await graph.createNodeWithId("tag:t", { label: "t", created_at: 1 });
            await graph.relate(m1, "tagged", t);
            await graph.relate(m2, "tagged", t);

            await graph.deleteEdges("tagged", { in: [m1, m2] });
            const rows = await db.query("SELECT * FROM tagged");
            expect(rows).toHaveLength(0);
        } finally {
            await db.close();
        }
    });

    test("transaction rolls back relate on throw", async () => {
        const { db, graph } = await setup();
        try {
            const m = await graph.createNode("memory", {
                content: "m",
                created_at: 1,
                token_count: 0,
            });
            const t = await graph.createNodeWithId("tag:r", { label: "r", created_at: 1 });

            await expect(
                graph.transaction(async (tx) => {
                    await tx.relate(m, "tagged", t);
                    throw new Error("nope");
                }),
            ).rejects.toThrow("nope");

            const after = await graph.outgoing(m, "tagged");
            expect(after).toHaveLength(0);
        } finally {
            await db.close();
        }
    });

    test("embedding (vector) round-trip via createNode", async () => {
        const { db, graph } = await setup();
        try {
            const id = await graph.createNode("memory", {
                content: "vec",
                created_at: 1,
                token_count: 0,
                embedding: [1, 0, 0, 0],
            });
            // Read back as text — pgvector returns vector as string `[1,0,0,0]`.
            const rows = await db.query<{ embedding: string }>(
                "SELECT embedding::text AS embedding FROM memory WHERE id = $1",
                [id],
            );
            expect(rows[0].embedding).toBe("[1,0,0,0]");
        } finally {
            await db.close();
        }
    });
});
