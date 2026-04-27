import { describe, test, expect } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import type { LLMAdapter, EmbeddingAdapter } from "../src/core/types.js";

const fakeLlm: LLMAdapter = {
    extract(): Promise<string[]> {
        return Promise.resolve([]);
    },
    consolidate(): Promise<string> {
        return Promise.resolve("");
    },
};

function embedOne(text: string): number[] {
    const t = text.toLowerCase();
    return [t.includes("alpha") ? 1 : 0, t.includes("beta") ? 1 : 0, t.includes("gamma") ? 1 : 0];
}

const fakeEmbed: EmbeddingAdapter = {
    dimension: 3,
    embed(text: string): Promise<number[]> {
        return Promise.resolve(embedOne(text));
    },
    embedBatch(texts: string[]): Promise<number[][]> {
        return Promise.resolve(texts.map(embedOne));
    },
};

async function makeEngine() {
    const engine = new MemoryEngine();
    await engine.initialize({
        connection: "mem://", // legacy alias for in-memory PGLite
        llm: fakeLlm,
        embedding: fakeEmbed,
    });
    return engine;
}

describe("MemoryEngine over Postgres", () => {
    test("initializes via legacy 'mem://' connection string", async () => {
        const engine = await makeEngine();
        await engine.close();
    });

    test("ingest + getMemory roundtrip with autoOwn domain", async () => {
        const engine = await makeEngine();
        try {
            await engine.registerDomain({
                id: "demo",
                name: "Demo",
                schedules: [],
                settings: { autoOwn: true },
                async processInboxBatch() {},
            });

            const result = await engine.ingest("alpha story", { skipDedup: true });
            expect(result.action).toBe("stored");
            if (!("id" in result) || !result.id) throw new Error("expected ingested id");
            const id = result.id;
            expect(id).toMatch(/^memory:/);

            const got = await engine.getMemory(id);
            expect(got?.content).toBe("alpha story");
        } finally {
            await engine.close();
        }
    });

    test("search() vector mode returns ingested memory", async () => {
        const engine = await makeEngine();
        try {
            await engine.registerDomain({
                id: "demo",
                name: "Demo",
                schedules: [],
                settings: { autoOwn: true },
                async processInboxBatch() {},
            });

            await engine.ingest("alpha story", { skipDedup: true });
            await engine.ingest("beta story", { skipDedup: true });

            const result = await engine.search({
                text: "alpha",
                mode: "vector",
                limit: 5,
            });
            expect(result.entries.length).toBeGreaterThan(0);
            expect(result.entries[0].content).toBe("alpha story");
        } finally {
            await engine.close();
        }
    });

    test("dedup detects duplicate ingests", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            llm: fakeLlm,
            embedding: fakeEmbed,
            repetition: { duplicateThreshold: 0.95, reinforceThreshold: 0.5 },
        });
        try {
            await engine.registerDomain({
                id: "demo",
                name: "Demo",
                schedules: [],
                settings: { autoOwn: true },
                async processInboxBatch() {},
            });

            const r1 = await engine.ingest("alpha story");
            expect(r1.action).toBe("stored");

            const r2 = await engine.ingest("alpha story");
            expect(r2.action).toBe("skipped");
        } finally {
            await engine.close();
        }
    });

    test("tagMemory + getMemoryTags", async () => {
        const engine = await makeEngine();
        try {
            await engine.registerDomain({
                id: "demo",
                name: "Demo",
                schedules: [],
                settings: { autoOwn: true },
                async processInboxBatch() {},
            });
            const r = await engine.ingest("alpha story", { skipDedup: true });
            if (!("id" in r) || !r.id) throw new Error("expected ingested id");
            await engine.tagMemory(r.id, "important");
            const tags = await engine.getMemoryTags(r.id);
            expect(tags).toContain("important");
        } finally {
            await engine.close();
        }
    });
});
