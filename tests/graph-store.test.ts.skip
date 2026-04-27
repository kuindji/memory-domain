import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Surreal } from "surrealdb";
import { GraphStore } from "../src/core/graph-store.js";
import { createTestDb } from "./helpers.js";

describe("GraphStore", () => {
    let db: Surreal;
    let store: GraphStore;

    beforeEach(async () => {
        db = await createTestDb();
        await db.query("DEFINE TABLE test_node SCHEMALESS");
        await db.query("DEFINE TABLE test_edge SCHEMALESS TYPE RELATION");
        store = new GraphStore(db);
    });

    afterEach(async () => {
        await db.close();
    });

    describe("node CRUD", () => {
        test("createNode returns an id", async () => {
            const id = await store.createNode("test_node", { name: "hello" });
            expect(id).toBeTruthy();
            expect(id).toContain("test_node:");
        });

        test("getNode retrieves created node", async () => {
            const id = await store.createNode("test_node", { name: "hello" });
            const node = await store.getNode(id);
            expect(node).not.toBeNull();
            expect(node!.name).toBe("hello");
        });

        test("getNode returns null for nonexistent id", async () => {
            const node = await store.getNode("test_node:nonexistent");
            expect(node).toBeNull();
        });

        test("updateNode merges fields", async () => {
            const id = await store.createNode("test_node", { name: "hello", count: 1 });
            await store.updateNode(id, { count: 2 });
            const node = await store.getNode(id);
            expect(node!.name).toBe("hello");
            expect(node!.count).toBe(2);
        });

        test("deleteNode removes the node", async () => {
            const id = await store.createNode("test_node", { name: "hello" });
            const deleted = await store.deleteNode(id);
            expect(deleted).toBe(true);
            const node = await store.getNode(id);
            expect(node).toBeNull();
        });
    });

    describe("createNodeWithId", () => {
        test("creates a node with a specific id", async () => {
            const id = await store.createNodeWithId("test_node:myid", { name: "specific" });
            expect(id).toBe("test_node:myid");
            const node = await store.getNode(id);
            expect(node).not.toBeNull();
            expect(node!.name).toBe("specific");
        });
    });

    describe("edges", () => {
        test("relate creates an edge between nodes", async () => {
            const a = await store.createNode("test_node", { name: "a" });
            const b = await store.createNode("test_node", { name: "b" });
            const edgeId = await store.relate(a, "test_edge", b, { weight: 0.5 });
            expect(edgeId).toBeTruthy();
            expect(edgeId).toContain("test_edge:");
        });

        test("unrelate removes the edge", async () => {
            const a = await store.createNode("test_node", { name: "a" });
            const b = await store.createNode("test_node", { name: "b" });
            await store.relate(a, "test_edge", b);
            const removed = await store.unrelate(a, "test_edge", b);
            expect(removed).toBe(true);
        });
    });

    describe("traversal", () => {
        test("traverse follows edges", async () => {
            const a = await store.createNode("test_node", { name: "a" });
            const b = await store.createNode("test_node", { name: "b" });
            const c = await store.createNode("test_node", { name: "c" });
            await store.relate(a, "test_edge", b);
            await store.relate(a, "test_edge", c);

            const results = await store.traverse(a, "->test_edge->test_node");
            expect(results.length).toBe(2);
        });
    });

    describe("raw query", () => {
        test("query executes SurrealQL", async () => {
            await store.createNode("test_node", { name: "one" });
            await store.createNode("test_node", { name: "two" });
            const count = await store.query<number>("RETURN count(SELECT * FROM test_node)");
            expect(count).toBe(2);
        });
    });

    describe("transaction", () => {
        test("commits changes on success", async () => {
            await store.transaction(async (tx) => {
                await tx.createNode("test_node", { name: "tx_item" });
            });
            const results = await store.query<{ name: string }[]>("SELECT * FROM test_node");
            expect(results.length).toBe(1);
            expect(results[0].name).toBe("tx_item");
        });

        test("rolls back changes on error", async () => {
            try {
                await store.transaction(async (tx) => {
                    await tx.createNode("test_node", { name: "will_rollback" });
                    throw new Error("intentional failure");
                });
            } catch {
                // expected
            }
            const results = await store.query<{ name: string }[]>("SELECT * FROM test_node");
            expect(results.length).toBe(0);
        });
    });
});
