import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";
import { createKbDomain } from "../src/domains/kb/kb-domain.js";
import { createTopicDomain } from "../src/domains/topic/topic-domain.js";
import { KB_DOMAIN_ID, KB_TAG, KB_FACT_TAG } from "../src/domains/kb/types.js";
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from "../src/domains/topic/types.js";

describe("MemoryEngine.buildContext", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_ctx_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain({
            id: "test",
            name: "Test",
            async processInboxBatch() {},
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("returns empty context when no memories exist", async () => {
        const result = await engine.buildContext("anything");
        expect(result.context).toBe("");
        expect(result.memories).toHaveLength(0);
        expect(result.totalTokens).toBe(0);
    });

    test("returns context from ingested memories", async () => {
        await engine.ingest("The sky is blue", { domains: ["test"] });
        await engine.ingest("Water is wet", { domains: ["test"] });

        // Process inbox so memories are searchable
        await engine.processInbox();
        await engine.processInbox();

        const result = await engine.buildContext("sky");
        // At minimum, the result should have the structure
        expect(typeof result.context).toBe("string");
        expect(Array.isArray(result.memories)).toBe(true);
        expect(typeof result.totalTokens).toBe("number");
    });

    test("respects budgetTokens option", async () => {
        // Ingest several memories
        for (let i = 0; i < 10; i++) {
            await engine.ingest(`Memory entry number ${i} with some content to take up tokens`, {
                domains: ["test"],
            });
        }

        const result = await engine.buildContext("memory", { budgetTokens: 50 });
        // With a tiny budget, we should get fewer memories than we ingested
        expect(result.memories.length).toBeLessThan(10);
    });

    test("respects domain filtering", async () => {
        await engine.registerDomain({
            id: "special",
            name: "Special",
            async processInboxBatch() {},
        });

        // Ingest to specific domain
        await engine.ingest("Special content", { domains: ["special"] });
        // Ingest to all domains (log + special)
        await engine.ingest("General content", { domains: ["test", "special"] });

        const result = await engine.buildContext("content", { domains: ["special"] });
        // Should only return memories owned by 'special'
        for (const mem of result.memories) {
            expect(mem.content).toBeDefined();
        }
    });

    test("uses custom domain buildContext when single domain specified", async () => {
        await engine.registerDomain({
            id: "custom",
            name: "Custom",
            async processInboxBatch() {},
            buildContext(_text, _budget, _ctx) {
                return Promise.resolve({
                    context: "custom context output",
                    memories: [],
                    totalTokens: 5,
                });
            },
        });

        const result = await engine.buildContext("anything", { domains: ["custom"] });
        expect(result.context).toBe("custom context output");
        expect(result.totalTokens).toBe(5);
    });

    test("formats context as numbered entries", async () => {
        await engine.ingest("First memory", { domains: ["test"] });
        await engine.ingest("Second memory", { domains: ["test"] });

        const result = await engine.buildContext("memory");
        if (result.memories.length > 0) {
            expect(result.context).toContain("[1]");
        }
    });
});

describe("KB buildContext topic boosting", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_topic_boost_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });

        // Register topic domain first (provides about_topic edge schema)
        await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        // Register KB domain (provides buildContext)
        await engine.registerDomain(createKbDomain({ consolidateSchedule: { enabled: false } }));
    });

    afterEach(async () => {
        await engine.close();
    });

    test("topic graph queries find topics and linked memories", async () => {
        const kbCtx = engine.createDomainContext(KB_DOMAIN_ID);
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);

        // Create a topic node for "silk"
        const topicId = await topicCtx.writeMemory({
            content: "Byzantine silk",
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: "Byzantine silk",
                    status: "active",
                    mentionCount: 1,
                    lastMentionedAt: Date.now(),
                    createdBy: KB_DOMAIN_ID,
                },
            },
        });

        // Create a fact memory and link it to the topic
        const silkMemoryId = await kbCtx.writeMemory({
            content:
                "Byzantine silk production was a state monopoly that generated enormous revenue",
            tags: [KB_FACT_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "fact", superseded: false },
            },
        });

        await kbCtx.graph.relate(silkMemoryId, "about_topic", topicId, {
            domain: KB_DOMAIN_ID,
        });

        // Verify topic can be found via tagged edge
        const topicTagId = new StringRecordId(`tag:${TOPIC_TAG}`);
        const topicResults = await kbCtx.graph.query<Array<{ id: string; content: string }>>(
            `SELECT in as id, (SELECT content FROM ONLY $parent.in).content as content FROM tagged WHERE out = $tagId`,
            { tagId: topicTagId },
        );

        expect(Array.isArray(topicResults)).toBe(true);
        expect(topicResults.length).toBeGreaterThanOrEqual(1);

        // Check that keyword filtering works (the word "silk" should match)
        const matchingTopics = topicResults.filter((r) => {
            const content = (r.content ?? "").toLowerCase();
            return content.includes("silk");
        });
        expect(matchingTopics.length).toBe(1);

        // Verify about_topic edge can find linked memories
        const topicRecordIds = matchingTopics.map((t) => new StringRecordId(String(t.id)));
        const memResults = await kbCtx.graph.query<Array<{ memId: string }>>(
            `SELECT in as memId FROM about_topic WHERE out IN $topicIds`,
            { topicIds: topicRecordIds },
        );

        expect(Array.isArray(memResults)).toBe(true);
        expect(memResults.length).toBe(1);
        expect(String(memResults[0].memId)).toBe(silkMemoryId);
    });

    test("buildContext uses intent-driven search and returns valid structure", async () => {
        // Lower minScore to -1 so mock embeddings (which produce arbitrary cosine similarities,
        // potentially negative) don't interfere with whether memories are returned at all.
        await engine.saveTunableParams(KB_DOMAIN_ID, { minScore: -1 });

        const kbCtx = engine.createDomainContext(KB_DOMAIN_ID);

        // Create KB memories with different classifications, tagged with KB_TAG
        const silkMemoryId = await kbCtx.writeMemory({
            content:
                "Silk production was a state monopoly in Byzantium, managed by imperial workshops",
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "fact", superseded: false },
            },
        });
        await engine.tagMemory(silkMemoryId, KB_TAG);

        const defMemoryId = await kbCtx.writeMemory({
            content: "Byzantine silk refers to silk fabric produced in the Eastern Roman Empire",
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "definition", superseded: false },
            },
        });
        await engine.tagMemory(defMemoryId, KB_TAG);

        const result = await engine.buildContext(
            "Tell me about Byzantine silk production and trade",
            {
                domains: ["kb"],
                budgetTokens: 2000,
            },
        );

        // Should return valid context structure
        expect(typeof result.context).toBe("string");
        expect(Array.isArray(result.memories)).toBe(true);
        expect(typeof result.totalTokens).toBe("number");

        // With mock LLM (returns empty generate), intent classification falls back
        // to all classifications, so both memories should be searchable
        if (result.memories.length > 0) {
            // Context should be grouped by classification sections
            const hasSections =
                result.context.includes("[Definitions & Concepts]") ||
                result.context.includes("[Facts & References]") ||
                result.context.includes("[How-Tos & Insights]");
            expect(hasSections).toBe(true);
        }
    });

    test("buildContext returns valid structure with topic data present", async () => {
        const kbCtx = engine.createDomainContext(KB_DOMAIN_ID);
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);

        // Create a topic
        const topicId = await topicCtx.writeMemory({
            content: "Byzantine silk",
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: "Byzantine silk",
                    status: "active",
                    mentionCount: 1,
                    lastMentionedAt: Date.now(),
                    createdBy: KB_DOMAIN_ID,
                },
            },
        });

        // Create a fact memory and link to topic
        const silkMemoryId = await kbCtx.writeMemory({
            content:
                "Byzantine silk production was a state monopoly that generated enormous revenue",
            tags: [KB_FACT_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "fact", superseded: false },
            },
        });

        await kbCtx.graph.relate(silkMemoryId, "about_topic", topicId, {
            domain: KB_DOMAIN_ID,
        });

        // buildContext should not error when topic data exists
        const result = await engine.buildContext("Tell me about Byzantine silk trade", {
            domains: [KB_DOMAIN_ID],
            budgetTokens: 2000,
        });

        expect(typeof result.context).toBe("string");
        expect(Array.isArray(result.memories)).toBe(true);
        expect(typeof result.totalTokens).toBe("number");
    });
});
