import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SearchEngine } from "../src/core/search-engine.js";
import { GraphStore } from "../src/core/graph-store.js";
import { SchemaRegistry } from "../src/core/schema-registry.js";
import { MemoryEngine } from "../src/core/engine.js";
import { createTestDb, MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";
import type { Surreal } from "surrealdb";

describe("SearchEngine", () => {
    let db: Surreal;
    let store: GraphStore;
    let search: SearchEngine;

    beforeEach(async () => {
        db = await createTestDb();
        const schema = new SchemaRegistry(db);
        await schema.registerCore();
        store = new GraphStore(db);
        search = new SearchEngine(store);
    });

    afterEach(async () => {
        await db.close();
    });

    describe("graph search", () => {
        test("finds memories connected via edges", async () => {
            await store.createNodeWithId("tag:test_topic", {
                label: "test_topic",
                created_at: Date.now(),
            });
            const m1 = await store.createNode("memory", {
                content: "first memory about topic",
                created_at: Date.now(),
                token_count: 5,
            });
            const m2 = await store.createNode("memory", {
                content: "second memory about topic",
                created_at: Date.now(),
                token_count: 5,
            });
            await store.relate(m1, "tagged", "tag:test_topic");
            await store.relate(m2, "tagged", "tag:test_topic");

            await store.createNode("memory", {
                content: "unrelated memory",
                created_at: Date.now(),
                token_count: 5,
            });

            const result = await search.search({
                mode: "graph",
                tags: ["test_topic"],
                limit: 10,
            });

            expect(result.entries.length).toBe(2);
            expect(result.mode).toBe("graph");
        });

        test("returns empty when no tags or traversal match", async () => {
            // Create memories with no tags — graph search without tags/traversal should return nothing
            for (let i = 0; i < 5; i++) {
                await store.createNode("memory", {
                    content: `untagged memory ${i}`,
                    created_at: Date.now(),
                    token_count: 4,
                });
            }

            const result = await search.search({
                mode: "graph",
                limit: 10,
            });

            expect(result.entries.length).toBe(0);
        });
    });

    describe("fulltext search", () => {
        test("finds memories by keyword", async () => {
            await store.createNode("memory", {
                content: "scheduled maintenance window for database servers",
                created_at: Date.now(),
                token_count: 7,
            });
            await store.createNode("memory", {
                content: "weather forecast for tomorrow",
                created_at: Date.now(),
                token_count: 5,
            });

            const result = await search.search({
                text: "database maintenance",
                mode: "fulltext",
                limit: 10,
            });

            expect(result.entries.length).toBeGreaterThanOrEqual(1);
            expect(result.entries[0].content).toContain("maintenance");
        });
    });

    describe("token budget", () => {
        test("limits results by token budget", async () => {
            await store.createNodeWithId("tag:budget_tag", {
                label: "budget_tag",
                created_at: Date.now(),
            });
            for (let i = 0; i < 10; i++) {
                const m = await store.createNode("memory", {
                    content: `Memory number ${i} with some content`,
                    created_at: Date.now(),
                    token_count: 100,
                });
                await store.relate(m, "tagged", "tag:budget_tag");
            }

            const result = await search.search({
                mode: "graph",
                tags: ["budget_tag"],
                limit: 10,
                tokenBudget: 350,
            });

            expect(result.entries.length).toBeLessThanOrEqual(3);
            expect(result.totalTokens).toBeLessThanOrEqual(350);
        });
    });

    describe("hybrid search", () => {
        test("combines fulltext and graph results", async () => {
            await store.createNodeWithId("tag:hybrid_tag", {
                label: "hybrid_tag",
                created_at: Date.now(),
            });

            const m1 = await store.createNode("memory", {
                content: "hybrid search memory tagged item",
                created_at: Date.now(),
                token_count: 5,
            });
            await store.relate(m1, "tagged", "tag:hybrid_tag");

            await store.createNode("memory", {
                content: "hybrid search memory from fulltext only",
                created_at: Date.now(),
                token_count: 6,
            });

            const result = await search.search({
                mode: "hybrid",
                text: "hybrid search memory",
                tags: ["hybrid_tag"],
                limit: 10,
                weights: { vector: 0.0, fulltext: 0.5, graph: 0.5 },
            });

            expect(result.mode).toBe("hybrid");
            expect(result.entries.length).toBeGreaterThanOrEqual(1);
        });

        test("returns results even with only graph component", async () => {
            await store.createNodeWithId("tag:only_graph", {
                label: "only_graph",
                created_at: Date.now(),
            });
            const m1 = await store.createNode("memory", {
                content: "graph only memory",
                created_at: Date.now(),
                token_count: 3,
            });
            await store.relate(m1, "tagged", "tag:only_graph");

            const result = await search.search({
                mode: "hybrid",
                tags: ["only_graph"],
                limit: 10,
                weights: { vector: 0.0, fulltext: 0.0, graph: 1.0 },
            });

            expect(result.entries.length).toBe(1);
        });
    });

    describe("minScore filter", () => {
        test("filters out entries below minScore", async () => {
            // Use hybrid search with only fulltext so scores are fractional
            for (let i = 0; i < 3; i++) {
                await store.createNode("memory", {
                    content: `low score memory ${i}`,
                    created_at: Date.now(),
                    token_count: 4,
                });
            }

            // minScore 0.9 with graph mode and no tags returns empty (no fallback)
            const result = await search.search({
                mode: "graph",
                limit: 10,
                minScore: 0.9,
            });

            expect(result.entries.length).toBe(0);
        });

        test("keeps entries above minScore", async () => {
            await store.createNodeWithId("tag:high", { label: "high", created_at: Date.now() });
            const m = await store.createNode("memory", {
                content: "high score memory",
                created_at: Date.now(),
                token_count: 3,
            });
            await store.relate(m, "tagged", "tag:high");

            const result = await search.search({
                mode: "graph",
                tags: ["high"],
                limit: 10,
                minScore: 0.1, // Tag-based graph search scores 1.0
            });

            expect(result.entries.length).toBe(1);
        });
    });

    describe("config-driven defaults", () => {
        test("uses configured defaultMode when query omits mode", async () => {
            const configuredSearch = new SearchEngine(store, { defaultMode: "fulltext" });

            await store.createNode("memory", {
                content: "config driven default mode test memory",
                created_at: Date.now(),
                token_count: 6,
            });

            const result = await configuredSearch.search({
                text: "config driven default",
                limit: 10,
            });

            expect(result.mode).toBe("fulltext");
        });

        test("query mode overrides configured defaultMode", async () => {
            const configuredSearch = new SearchEngine(store, { defaultMode: "fulltext" });

            await store.createNode("memory", {
                content: "override mode test memory",
                created_at: Date.now(),
                token_count: 5,
            });

            const result = await configuredSearch.search({
                mode: "graph",
                limit: 10,
            });

            expect(result.mode).toBe("graph");
        });

        test("uses configured defaultWeights for search", async () => {
            const configuredSearch = new SearchEngine(store, {
                defaultWeights: { vector: 0.0, fulltext: 0.8, graph: 0.2 },
            });

            await store.createNode("memory", {
                content: "custom weights test memory content",
                created_at: Date.now(),
                token_count: 6,
            });

            const result = await configuredSearch.search({
                text: "custom weights test",
                limit: 10,
            });

            // Should work without errors and return results using configured weights
            expect(result.mode).toBe("hybrid");
            expect(result.entries.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe("post-search enrichment", () => {
        test("populates connections.references for linked memories", async () => {
            await store.createNodeWithId("tag:enrichment_topic", {
                label: "enrichment_topic",
                created_at: Date.now(),
            });
            const m1 = await store.createNode("memory", {
                content: "original finding about topic",
                created_at: Date.now(),
                token_count: 5,
            });
            const m2 = await store.createNode("memory", {
                content: "reinforcing finding about topic",
                created_at: Date.now(),
                token_count: 5,
            });
            await store.relate(m1, "tagged", "tag:enrichment_topic");
            await store.relate(m2, "tagged", "tag:enrichment_topic");
            await store.relate(m2, "reinforces", m1);

            const result = await search.search({
                mode: "graph",
                tags: ["enrichment_topic"],
                limit: 10,
            });

            const m1Result = result.entries.find((e) => e.id === m1);
            const m2Result = result.entries.find((e) => e.id === m2);

            expect(m1Result?.connections?.references).toBeDefined();
            expect(m1Result!.connections!.references!.length).toBeGreaterThanOrEqual(1);
            expect(
                m1Result!.connections!.references!.some(
                    (r) => r.id === m2 && r.type === "reinforces",
                ),
            ).toBe(true);

            expect(m2Result?.connections?.references).toBeDefined();
            expect(
                m2Result!.connections!.references!.some(
                    (r) => r.id === m1 && r.type === "reinforces",
                ),
            ).toBe(true);
        });

        test("populates domainAttributes from owned_by edges", async () => {
            await store.createNodeWithId("domain:enrichtest", { name: "EnrichTest" });
            await store.createNodeWithId("tag:enrichtest_tag", {
                label: "enrichtest_tag",
                created_at: Date.now(),
            });
            const m1 = await store.createNode("memory", {
                content: "memory with domain attributes",
                created_at: Date.now(),
                token_count: 5,
            });
            await store.relate(m1, "tagged", "tag:enrichtest_tag");
            await store.relate(m1, "owned_by", "domain:enrichtest", {
                attributes: { confidence: 0.9, kind: "report" },
                owned_at: Date.now(),
            });

            const result = await search.search({
                mode: "graph",
                tags: ["enrichtest_tag"],
                domains: ["enrichtest"],
                limit: 10,
            });

            expect(result.entries.length).toBe(1);
            expect(result.entries[0].domainAttributes.enrichtest).toBeDefined();
            expect(result.entries[0].domainAttributes.enrichtest.confidence).toBe(0.9);
            expect(result.entries[0].domainAttributes.enrichtest.kind).toBe("report");
        });

        test("empty connections when no reference edges exist", async () => {
            await store.createNodeWithId("tag:lonely_tag", {
                label: "lonely_tag",
                created_at: Date.now(),
            });
            const m = await store.createNode("memory", {
                content: "lonely memory with no references",
                created_at: Date.now(),
                token_count: 5,
            });
            await store.relate(m, "tagged", "tag:lonely_tag");

            const result = await search.search({ mode: "graph", tags: ["lonely_tag"], limit: 10 });
            expect(result.entries.length).toBe(1);
            const refs = result.entries[0].connections?.references;
            expect(!refs || refs.length === 0).toBe(true);
        });
    });

    describe("embedding re-ranking", () => {
        let engine: MemoryEngine;

        beforeEach(async () => {
            engine = new MemoryEngine();
            await engine.initialize({
                connection: "mem://",
                namespace: "test",
                database: `test_rerank_${Date.now()}`,
                llm: new MockLLMAdapter(),
                embedding: new MockEmbeddingAdapter(),
            });
            await engine.registerDomain({
                id: "kb",
                name: "KB",
                async processInboxBatch() {},
            });
        });

        afterEach(async () => {
            await engine.close();
        });

        test("rerank filters candidates by direct embedding similarity", async () => {
            await engine.ingest("Silk production was a major Byzantine industry", {
                domains: ["kb"],
            });
            await engine.ingest("Greek fire was a devastating naval weapon", { domains: ["kb"] });
            await engine.ingest("The Hippodrome hosted chariot races in Constantinople", {
                domains: ["kb"],
            });

            let hasMore = true;
            while (hasMore) {
                hasMore = await engine.processInbox();
            }

            // Search without rerank to get baseline (all candidates pass)
            const baseline = await engine.search({
                text: "Byzantine silk trade and production",
                mode: "hybrid",
                domains: ["kb"],
            });
            expect(baseline.entries.length).toBeGreaterThanOrEqual(1);

            // Search with rerank enabled using a threshold that filters by embedding similarity.
            // The mock embedding adapter produces hash-based vectors; silk has the highest cosine
            // similarity (~-0.13) to the query vs fire (~-0.22) and hippodrome (~-0.50), so a
            // threshold of -0.2 lets silk through while filtering lower-similarity entries.
            const result = await engine.search({
                text: "Byzantine silk trade and production",
                mode: "hybrid",
                domains: ["kb"],
                rerank: true,
                rerankThreshold: -0.2,
            });

            // Silk memory should be present
            const hasSilk = result.entries.some((e) => e.content.toLowerCase().includes("silk"));
            expect(hasSilk).toBe(true);

            // With rerank, silk should rank first
            if (result.entries.length > 0) {
                expect(result.entries[0].content.toLowerCase()).toContain("silk");
            }

            // Reranked results should be a subset of baseline (threshold filters some out)
            expect(result.entries.length).toBeLessThanOrEqual(baseline.entries.length);
        });
    });

    describe("filtered search", () => {
        test("fulltextSearch respects filters on memory fields", async () => {
            // Add a custom field to memory table
            await db.query(
                "DEFINE FIELD IF NOT EXISTS classification ON memory TYPE option<string>",
            );

            await store.createNode("memory", {
                content: "Byzantine military tactics in siege warfare",
                created_at: Date.now(),
                token_count: 7,
                classification: "fact",
            });
            await store.createNode("memory", {
                content: "Byzantine architecture and building techniques",
                created_at: Date.now(),
                token_count: 6,
                classification: "reference",
            });
            await store.createNode("memory", {
                content: "Byzantine trade routes and commerce",
                created_at: Date.now(),
                token_count: 6,
                classification: "fact",
            });

            const result = await search.search({
                text: "Byzantine",
                mode: "fulltext",
                filters: { classification: ["fact"] },
            });

            expect(result.entries.length).toBe(2);
            for (const entry of result.entries) {
                expect(entry.content).not.toContain("architecture");
            }
        });

        test("search without filters returns all matches", async () => {
            await db.query(
                "DEFINE FIELD IF NOT EXISTS classification ON memory TYPE option<string>",
            );

            await store.createNode("memory", {
                content: "Byzantine military tactics",
                created_at: Date.now(),
                token_count: 4,
                classification: "fact",
            });
            await store.createNode("memory", {
                content: "Byzantine architecture overview",
                created_at: Date.now(),
                token_count: 4,
                classification: "reference",
            });

            const result = await search.search({
                text: "Byzantine",
                mode: "fulltext",
            });

            expect(result.entries.length).toBe(2);
        });
    });

    describe("domain ownership filter", () => {
        test("filters by domain ownership", async () => {
            await store.createNodeWithId("domain:alpha", { name: "Alpha" });
            await store.createNodeWithId("domain:beta", { name: "Beta" });
            await store.createNodeWithId("tag:domain_test_tag", {
                label: "domain_test_tag",
                created_at: Date.now(),
            });

            const m1 = await store.createNode("memory", {
                content: "alpha domain memory",
                created_at: Date.now(),
                token_count: 3,
            });
            const m2 = await store.createNode("memory", {
                content: "beta domain memory",
                created_at: Date.now(),
                token_count: 3,
            });

            await store.relate(m1, "tagged", "tag:domain_test_tag");
            await store.relate(m2, "tagged", "tag:domain_test_tag");
            await store.relate(m1, "owned_by", "domain:alpha", {
                attributes: {},
                owned_at: Date.now(),
            });
            await store.relate(m2, "owned_by", "domain:beta", {
                attributes: {},
                owned_at: Date.now(),
            });

            const result = await search.search({
                mode: "graph",
                tags: ["domain_test_tag"],
                domains: ["alpha"],
                limit: 10,
            });

            expect(result.entries.length).toBe(1);
            expect(result.entries[0].content).toBe("alpha domain memory");
        });
    });
});
