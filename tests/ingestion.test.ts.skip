import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";

describe("MemoryEngine", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain({
            id: "test",
            name: "Test",
            settings: { autoOwn: true },
            async processInboxBatch() {},
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    describe("initialize", () => {
        test("creates core schema", async () => {
            const result = await engine.search({ mode: "graph", limit: 10 });
            expect(result.entries).toEqual([]);
        });
    });

    describe("ingest", () => {
        test("stores a memory and tags it with inbox", async () => {
            const result = await engine.ingest("Test content for ingestion");
            expect(result.action).toBe("stored");
            expect(result.id).toBeTruthy();

            const memory = await engine.getGraph().getNode(result.id!);
            expect(memory).not.toBeNull();
            expect(memory!.content).toBe("Test content for ingestion");
        });

        test("autoOwn domain gets ownership without explicit --domain", async () => {
            const result = await engine.ingest("Some content");

            const owners = await engine
                .getGraph()
                .query<
                    { out: string }[]
                >("SELECT out FROM owned_by WHERE in = $id", { id: new StringRecordId(result.id!) });

            const domainIds = (owners ?? []).map((o) => String(o.out));
            expect(domainIds).toContain("domain:test");
        });

        test("domain with assertInboxClaimBatch gets assert-claim tag at ingestion", async () => {
            await engine.registerDomain({
                id: "claimer",
                name: "Claimer",
                async processInboxBatch() {},
                assertInboxClaimBatch(entries) {
                    return Promise.resolve(entries.map((e) => e.memory.id));
                },
            });

            const result = await engine.ingest("Claimable content");

            const tags = await engine
                .getGraph()
                .traverse<{ id: string; label: string }>(result.id!, "->tagged->tag");
            const tagLabels = tags.map((t) => t.label ?? String(t.id));
            expect(tagLabels).toContain("inbox:assert-claim:claimer");
        });

        test("domain without autoOwn or assertInboxClaimBatch gets no ownership or tags", async () => {
            await engine.registerDomain({
                id: "passive",
                name: "Passive",
                async processInboxBatch() {},
            });

            const result = await engine.ingest("Some content");

            const owners = await engine
                .getGraph()
                .query<
                    { out: string }[]
                >("SELECT out FROM owned_by WHERE in = $id", { id: new StringRecordId(result.id!) });
            const domainIds = (owners ?? []).map((o) => String(o.out));
            expect(domainIds).not.toContain("domain:passive");
        });

        test("ingest with specific domains targets only those domains", async () => {
            await engine.registerDomain({
                id: "domain_a",
                name: "A",
                async processInboxBatch() {},
            });
            await engine.registerDomain({
                id: "domain_b",
                name: "B",
                async processInboxBatch() {},
            });

            const result = await engine.ingest("Targeted content", { domains: ["domain_a"] });

            const owners = await engine
                .getGraph()
                .query<
                    { out: string }[]
                >("SELECT out FROM owned_by WHERE in = $id", { id: new StringRecordId(result.id!) });

            const domainIds = (owners ?? []).map((o) => String(o.out));
            expect(domainIds).toContain("domain:domain_a");
            expect(domainIds).not.toContain("domain:domain_b");

            // Should also have inbox processing tag
            const tags = await engine
                .getGraph()
                .traverse<{ id: string; label: string }>(result.id!, "->tagged->tag");
            const tagLabels = tags.map((t) => t.label ?? String(t.id));
            expect(tagLabels).toContain("inbox:domain_a");
        });
    });

    describe("ref-counted deletion", () => {
        test("memory is deleted when all owners release it", async () => {
            await engine.registerDomain({
                id: "domain_a",
                name: "A",
                async processInboxBatch() {},
            });

            const result = await engine.ingest("Owned content", { domains: ["domain_a"] });
            const memId = result.id!;

            await engine.releaseOwnership(memId, "domain_a");
            await engine.releaseOwnership(memId, "test");

            const memory = await engine.getGraph().getNode(memId);
            expect(memory).toBeNull();
        });

        test("memory survives when one owner remains", async () => {
            await engine.registerDomain({
                id: "domain_a",
                name: "A",
                async processInboxBatch() {},
            });
            await engine.registerDomain({
                id: "domain_b",
                name: "B",
                async processInboxBatch() {},
            });

            const result = await engine.ingest("Shared content", {
                domains: ["domain_a", "domain_b"],
            });
            const memId = result.id!;

            await engine.releaseOwnership(memId, "domain_a");

            const memory = await engine.getGraph().getNode(memId);
            expect(memory).not.toBeNull();
        });

        test("domain-defined edges are cleaned up on deletion", async () => {
            await engine.registerDomain({
                id: "edge_test",
                name: "Edge Test",
                schema: {
                    nodes: [],
                    edges: [{ name: "analyzed_by", from: "memory", to: "memory" }],
                },
                async processInboxBatch() {},
            });

            const r1 = await engine.ingest("first memory", { domains: ["edge_test"] });
            const r2 = await engine.ingest("second memory", { domains: ["edge_test"] });

            // Create a custom domain edge between the two memories
            await engine.getGraph().relate(r1.id!, "analyzed_by", r2.id!);

            // Verify edge exists
            const edgesBefore = await engine
                .getGraph()
                .query<
                    { id: string }[]
                >("SELECT id FROM analyzed_by WHERE in = $mem", { mem: new StringRecordId(r1.id!) });
            expect(edgesBefore?.length).toBe(1);

            // Release all ownership of first memory
            await engine.releaseOwnership(r1.id!, "edge_test");
            await engine.releaseOwnership(r1.id!, "test");

            // Memory should be deleted
            const mem = await engine.getGraph().getNode(r1.id!);
            expect(mem).toBeNull();

            // Custom edge should also be deleted
            const edgesAfter = await engine
                .getGraph()
                .query<
                    { id: string }[]
                >("SELECT id FROM analyzed_by WHERE in = $oldMem OR out = $oldMem", { oldMem: new StringRecordId(r1.id!) });
            expect(edgesAfter?.length ?? 0).toBe(0);
        });
    });
});

describe("deduplication", () => {
    let dedupEngine: MemoryEngine;
    const embedding = new MockEmbeddingAdapter();

    beforeEach(async () => {
        dedupEngine = new MemoryEngine();
        await dedupEngine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_dedup_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding,
            repetition: { duplicateThreshold: 0.95, reinforceThreshold: 0.8 },
        });
        await dedupEngine.registerDomain({
            id: "test",
            name: "Test",
            settings: { autoOwn: true },
            async processInboxBatch() {},
        });
    });

    afterEach(async () => {
        await dedupEngine.close();
    });

    test("identical text is skipped", async () => {
        const r1 = await dedupEngine.ingest("exact duplicate content for testing");
        expect(r1.action).toBe("stored");

        const r2 = await dedupEngine.ingest("exact duplicate content for testing");
        expect(r2.action).toBe("skipped");
        expect(r2.existingId).toBe(r1.id);
    });

    test("skipDedup bypasses dedup check", async () => {
        await dedupEngine.ingest("content that will be duplicated");
        const r2 = await dedupEngine.ingest("content that will be duplicated", { skipDedup: true });
        expect(r2.action).toBe("stored");
    });

    test("no embedding adapter means no dedup", async () => {
        const noEmbedEngine = new MemoryEngine();
        await noEmbedEngine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_nodedup_${Date.now()}`,
            llm: new MockLLMAdapter(),
            repetition: { duplicateThreshold: 0.95, reinforceThreshold: 0.8 },
        });
        await noEmbedEngine.registerDomain({
            id: "test",
            name: "Test",
            settings: { autoOwn: true },
            async processInboxBatch() {},
        });

        await noEmbedEngine.ingest("duplicate without embedding");
        const r2 = await noEmbedEngine.ingest("duplicate without embedding");
        expect(r2.action).toBe("stored");
        await noEmbedEngine.close();
    });
});
