import { describe, test, expect } from "bun:test";
import { createPgliteClient } from "../src/adapters/pg/pglite-adapter.js";
import { SchemaRegistry } from "../src/core/schema-registry.js";
import { GraphStore } from "../src/core/graph-store.js";
import { SearchEngine } from "../src/core/search-engine.js";
import type { EmbeddingAdapter } from "../src/core/types.js";

const dim = 3;

function embedOne(text: string): number[] {
    const t = text.toLowerCase();
    return [
        t.includes("alpha") ? 1 : 0,
        t.includes("beta") ? 1 : 0,
        t.includes("gamma") ? 1 : 0,
    ];
}

const fakeEmbed: EmbeddingAdapter = {
    dimension: dim,
    async embed(text: string): Promise<number[]> {
        return embedOne(text);
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
        return texts.map(embedOne);
    },
};

async function setup() {
    const db = await createPgliteClient();
    const reg = new SchemaRegistry(db);
    await reg.registerCore(dim);
    const graph = new GraphStore(db);
    const search = new SearchEngine(graph, undefined, fakeEmbed);
    return { db, graph, search };
}

async function makeMemory(
    graph: GraphStore,
    content: string,
    embedding: number[],
    extra: Record<string, unknown> = {},
): Promise<string> {
    return graph.createNode("memory", {
        content,
        embedding,
        created_at: Date.now(),
        token_count: content.split(/\s+/).length,
        ...extra,
    });
}

describe("SearchEngine over Postgres", () => {
    test("vector mode returns nearest by cosine distance", async () => {
        const { db, graph, search } = await setup();
        try {
            const a = await makeMemory(graph, "alpha topic", [1, 0, 0]);
            const b = await makeMemory(graph, "beta topic", [0, 1, 0]);
            const c = await makeMemory(graph, "alpha and beta", [0.7, 0.7, 0]);

            const result = await search.search({ text: "alpha", mode: "vector", limit: 5 });
            const ids = result.entries.map((e) => e.id);
            expect(ids[0]).toBe(a);
            // c should rank above b because the alpha axis weighs in.
            expect(ids.indexOf(c)).toBeLessThan(ids.indexOf(b));
            expect(result.entries[0].scores.vector).toBeGreaterThan(0.9);
        } finally {
            await db.close();
        }
    });

    test("fulltext mode uses tsvector", async () => {
        const { db, graph, search } = await setup();
        try {
            const a = await makeMemory(graph, "the quick brown fox", [0, 0, 0]);
            await makeMemory(graph, "lazy dog napping", [0, 0, 0]);

            const result = await search.search({ text: "fox", mode: "fulltext", limit: 5 });
            expect(result.entries).toHaveLength(1);
            expect(result.entries[0].id).toBe(a);
        } finally {
            await db.close();
        }
    });

    test("graph mode by tag returns tagged memories", async () => {
        const { db, graph, search } = await setup();
        try {
            const a = await makeMemory(graph, "memo a", [0, 0, 0]);
            const b = await makeMemory(graph, "memo b", [0, 0, 0]);
            await makeMemory(graph, "memo c", [0, 0, 0]);
            await graph.createNodeWithId("tag:topic", { label: "topic", created_at: 1 });
            await graph.relate(a, "tagged", "tag:topic");
            await graph.relate(b, "tagged", "tag:topic");

            const result = await search.search({ tags: ["topic"], mode: "graph", limit: 10 });
            const ids = result.entries.map((e) => e.id).sort();
            expect(ids).toEqual([a, b].sort());
            for (const e of result.entries) {
                expect(e.tags).toContain("topic");
            }
        } finally {
            await db.close();
        }
    });

    test("graph mode with traversal pattern <-edge<-table", async () => {
        const { db, graph, search } = await setup();
        try {
            // Custom edge: about_topic from memory to topic
            await graph.run(`CREATE TABLE topic (id text PRIMARY KEY, label text NOT NULL)`);
            await graph.run(`CREATE TABLE about_topic (
                id text PRIMARY KEY,
                in_id text NOT NULL,
                out_id text NOT NULL
            )`);
            const t1 = "topic:nuclear";
            await graph.run(
                `INSERT INTO topic (id, label) VALUES ('${t1}', 'nuclear')`,
            );
            const m1 = await makeMemory(graph, "nuclear test", [0, 0, 0]);
            await graph.relate(m1, "about_topic", t1);

            const result = await search.search({
                mode: "graph",
                traversal: { from: t1, pattern: "<-about_topic<-memory.*" },
                limit: 5,
            });
            expect(result.entries.map((e) => e.id)).toEqual([m1]);
        } finally {
            await db.close();
        }
    });

    test("hybrid combines vector + fulltext", async () => {
        const { db, graph, search } = await setup();
        try {
            const a = await makeMemory(graph, "alpha story", [1, 0, 0]);
            const b = await makeMemory(graph, "beta story", [0, 1, 0]);
            await makeMemory(graph, "gamma story", [0, 0, 1]);

            const result = await search.search({
                text: "alpha",
                mode: "hybrid",
                limit: 5,
                weights: { vector: 1, fulltext: 1, graph: 0 },
            });
            // a should win — both vector and fulltext hit
            expect(result.entries[0].id).toBe(a);
            expect(result.entries[0].scores.vector).toBeDefined();
            expect(result.entries[0].scores.fulltext).toBeDefined();
            // b shows up only via vector noise (0 distance to alpha is highest;
            // beta has cosine=0 with alpha vector — distance=1 — so it ranks low)
            expect(result.entries.map((e) => e.id)).toContain(b);
        } finally {
            await db.close();
        }
    });

    test("filterByDomainOwnership scopes results", async () => {
        const { db, graph, search } = await setup();
        try {
            const a = await makeMemory(graph, "alpha", [1, 0, 0]);
            const b = await makeMemory(graph, "alpha", [1, 0, 0]);
            await graph.createNodeWithId("domain:foo", { name: "foo" });
            await graph.relate(a, "owned_by", "domain:foo");
            // b is unowned

            const result = await search.search({
                text: "alpha",
                mode: "vector",
                domains: ["foo"],
                limit: 5,
            });
            expect(result.entries.map((e) => e.id)).toEqual([a]);
            expect(result.entries[0].id).not.toBe(b);
        } finally {
            await db.close();
        }
    });

    test("hydrateTags populates tag labels on results", async () => {
        const { db, graph, search } = await setup();
        try {
            const a = await makeMemory(graph, "alpha", [1, 0, 0]);
            await graph.createNodeWithId("tag:t1", { label: "t1", created_at: 1 });
            await graph.createNodeWithId("tag:t2", { label: "t2", created_at: 1 });
            await graph.relate(a, "tagged", "tag:t1");
            await graph.relate(a, "tagged", "tag:t2");

            const result = await search.search({ text: "alpha", mode: "vector", limit: 5 });
            const entry = result.entries.find((e) => e.id === a)!;
            expect([...entry.tags].sort()).toEqual(["t1", "t2"]);
        } finally {
            await db.close();
        }
    });

    test("rerank via embedding adjusts scores", async () => {
        const { db, graph, search } = await setup();
        try {
            await makeMemory(graph, "noise", [0, 0, 0]);
            const target = await makeMemory(graph, "alpha alpha", [1, 0, 0]);

            const result = await search.search({
                text: "alpha",
                mode: "vector",
                rerank: true,
                rerankThreshold: 0.5,
                limit: 5,
            });
            expect(result.entries[0].id).toBe(target);
            expect(result.entries[0].score).toBeGreaterThanOrEqual(0.5);
        } finally {
            await db.close();
        }
    });
});
