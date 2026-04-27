import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter } from "./helpers.js";

describe("ingest with slash-containing tags", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_tag_slash_${Date.now()}`,
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

    test("two distinct slash tags produce two distinct tag nodes", async () => {
        const r1 = await engine.ingest("first entry", { tags: ["region/abw"] });
        const r2 = await engine.ingest("second entry", { tags: ["region/usa"] });

        expect(r1.action).toBe("stored");
        expect(r2.action).toBe("stored");

        const graph = engine.getGraph();

        const tagRows = await graph.query<{ id: unknown; label: string }[]>(
            "SELECT id, label FROM tag WHERE label INSIDE ['region/abw', 'region/usa']",
        );
        const labels = (tagRows ?? []).map((t) => t.label).sort();
        expect(labels).toEqual(["region/abw", "region/usa"]);

        const labelsForR1 = await graph.query<string[]>(
            "SELECT VALUE out.label FROM tagged WHERE in = $id",
            { id: new StringRecordId(r1.id!) },
        );
        expect(labelsForR1).toContain("region/abw");

        const labelsForR2 = await graph.query<string[]>(
            "SELECT VALUE out.label FROM tagged WHERE in = $id",
            { id: new StringRecordId(r2.id!) },
        );
        expect(labelsForR2).toContain("region/usa");
    });

    test("slash-tag ingested twice does not create a second tag node", async () => {
        await engine.ingest("entry one", { tags: ["domain/governance"] });
        await engine.ingest("entry two", { tags: ["domain/governance"] });

        const graph = engine.getGraph();
        const tagRows = await graph.query<{ label: string }[]>(
            "SELECT label FROM tag WHERE label = 'domain/governance'",
        );
        expect((tagRows ?? []).length).toBe(1);
    });

    test("tagMemory/untagMemory round-trip on slash tag", async () => {
        const r = await engine.ingest("round trip entry");
        await engine.tagMemory(r.id!, "region/grc");

        const graph = engine.getGraph();
        const labelQuery = "SELECT VALUE out.label FROM tagged WHERE in = $id";
        let labels = await graph.query<string[]>(labelQuery, {
            id: new StringRecordId(r.id!),
        });
        expect(labels).toContain("region/grc");

        await engine.untagMemory(r.id!, "region/grc");
        labels = await graph.query<string[]>(labelQuery, {
            id: new StringRecordId(r.id!),
        });
        expect(labels).not.toContain("region/grc");
    });
});

describe("record ids with hyphens are preserved", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_hyphen_ids_${Date.now()}`,
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

    test("createNodeWithId with hyphenated id keeps the full id, not a truncated prefix", async () => {
        const graph = engine.getGraph();
        const id1 = await graph.createNodeWithId("memory:abw-fdi-collapse-2001", {
            content: "Aruba FDI Collapse 2001",
            created_at: Date.now(),
            token_count: 0,
        });
        const id2 = await graph.createNodeWithId("memory:abw-fdi-surge-2002", {
            content: "Aruba FDI Surge 2002",
            created_at: Date.now(),
            token_count: 0,
        });

        expect(id1).not.toBe(id2);
        expect(id1).toContain("fdi-collapse-2001");
        expect(id2).toContain("fdi-surge-2002");

        const rows = await graph.query<{ id: unknown; content: string }[]>(
            "SELECT id, content FROM memory WHERE content INSIDE ['Aruba FDI Collapse 2001', 'Aruba FDI Surge 2002']",
        );
        expect((rows ?? []).length).toBe(2);
    });

    test("createNodeWithId is idempotent for the same hyphenated id (AlreadyExists)", async () => {
        const graph = engine.getGraph();
        await graph.createNodeWithId("memory:usa-severe-recession-2009", {
            content: "USA Severe Recession 2009",
            created_at: Date.now(),
            token_count: 0,
        });
        await expect(
            graph.createNodeWithId("memory:usa-severe-recession-2009", {
                content: "dup",
                created_at: Date.now(),
                token_count: 0,
            }),
        ).rejects.toThrow();
    });
});

describe("ingest persists metadata on memory row", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_metadata_row_${Date.now()}`,
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

    test("metadata is stored on the memory row and queryable", async () => {
        const r = await engine.ingest("GDP narrative for Greece 2009", {
            metadata: {
                source: "wdi",
                year: 2009,
                countryCode: "GRC",
                kind: "crisis-pattern",
            },
        });

        const rows = await engine
            .getGraph()
            .query<
                { metadata: Record<string, unknown> }[]
            >("SELECT metadata FROM memory WHERE id = $id", { id: new StringRecordId(r.id!) });
        expect(rows?.[0]?.metadata).toMatchObject({
            source: "wdi",
            year: 2009,
            countryCode: "GRC",
            kind: "crisis-pattern",
        });
    });

    test("omitting metadata leaves field unset", async () => {
        const r = await engine.ingest("no metadata entry");
        const rows = await engine
            .getGraph()
            .query<
                { metadata: unknown }[]
            >("SELECT metadata FROM memory WHERE id = $id", { id: new StringRecordId(r.id!) });
        expect(rows?.[0]?.metadata ?? null).toBeNull();
    });
});
