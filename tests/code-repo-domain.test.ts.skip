import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";
import { createCodeRepoDomain } from "../src/domains/code-repo/code-repo-domain.js";
import { topicDomain } from "../src/domains/topic/index.js";
import {
    CODE_REPO_DOMAIN_ID,
    CODE_REPO_TAG,
    CODE_REPO_DECISION_TAG,
} from "../src/domains/code-repo/types.js";

describe("Code repo domain - config", () => {
    test("declares 7 tunable params matching kb parity", () => {
        const reg = createCodeRepoDomain();
        expect(reg.domain.tunableParams).toBeDefined();
        const names = reg.domain.tunableParams!.map((p: { name: string }) => p.name).sort();
        expect(names).toEqual(
            [
                "decayFactor",
                "embeddingRerank",
                "importanceBoost",
                "llmRerank",
                "minScore",
                "mmrLambda",
                "useQuestionSearch",
            ].sort(),
        );
    });

    test("declares memory schema fields + related_knowledge edge", () => {
        const reg = createCodeRepoDomain();
        const memoryNode = reg.domain.schema!.nodes.find(
            (n: { name: string }) => n.name === "memory",
        );
        expect(memoryNode).toBeDefined();
        const fieldNames = memoryNode!.fields.map((f: { name: string }) => f.name);
        expect(fieldNames).toContain("classification");
        expect(fieldNames).toContain("topics");

        const relatedEdge = reg.domain.schema!.edges.find(
            (e: { name: string }) => e.name === "related_knowledge",
        );
        expect(relatedEdge).toBeDefined();
    });

    test("returns DomainRegistration with plugins and requires", () => {
        const reg = createCodeRepoDomain();
        expect(reg.plugins).toBeDefined();
        expect(reg.plugins!.length).toBeGreaterThan(0);
        expect(reg.requires).toContain("topic-linking");
    });

    test("supports custom domain id", () => {
        const reg = createCodeRepoDomain({ id: "my_code" });
        expect(reg.domain.id).toBe("my_code");
    });
});

describe("Code repo domain - inbox pipeline (mock LLM)", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        // MockLLMAdapter.generate returns generateResult as-is; the code-repo classifier
        // parses "1. decision\n2. observation\n..." style replies line-by-line.
        // Set it up so every classification returns "decision" (deterministic).
        llm.generateResult = "1. decision\n2. decision\n3. decision\n4. decision\n5. decision";
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_coderepo_${Date.now()}`,
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(createCodeRepoDomain());
        await engine.registerDomain(topicDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    test("processInboxBatch populates kb-style attributes on ingested memories", async () => {
        // MockLLMAdapter.generate returns generateResult — used for question-generation fallback
        llm.generateResult = "What is the primary datastore?";

        const result = await engine.ingest("Chose Postgres as the primary datastore", {
            domains: [CODE_REPO_DOMAIN_ID],
            metadata: { classification: "decision", audience: ["technical"] },
        });
        expect(result.action).toBe("stored");

        await engine.processInbox();

        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);
        const memories = await ctx.getMemories({ tags: [CODE_REPO_TAG] });
        expect(memories.length).toBeGreaterThanOrEqual(1);

        const target = memories.find((m) => m.content.includes("Postgres"));
        expect(target).toBeDefined();

        // Fetch owned_by attributes directly (MemoryEntry has no domainAttributes field)
        const attrRows = await engine
            .getGraph()
            .query<
                Array<{ attributes: Record<string, unknown> }>
            >("SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId LIMIT 1", {
                memId: new StringRecordId(target!.id),
                domainId: new StringRecordId(`domain:${CODE_REPO_DOMAIN_ID}`),
            });
        const attrs = attrRows?.[0]?.attributes;
        expect(attrs).toBeDefined();
        expect(attrs.classification).toBe("decision");
        expect(attrs.superseded).toBe(false);
        expect(typeof attrs.validFrom).toBe("number");
        expect(attrs.confidence).toBe(1.0);
        expect(typeof attrs.importance).toBe("number");
        expect(attrs.answersQuestion).toBeTypeOf("string");
        expect((attrs.answersQuestion as string).length).toBeGreaterThan(0);
    });
});

describe("Code repo domain - buildContext", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        llm.generateResult = "1. decision";
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_coderepo_ctx_${Date.now()}`,
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(createCodeRepoDomain());
        await engine.registerDomain(topicDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    test("returns empty context when no memories exist", async () => {
        const result = await engine.buildContext("datastore choice", {
            domains: [CODE_REPO_DOMAIN_ID],
            budgetTokens: 1000,
        });
        expect(result.context).toBe("");
        expect(result.memories).toEqual([]);
    });

    test("superseded entries are filtered out of buildContext", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);

        const memId = await ctx.writeMemory({
            content: "Use MongoDB for the orders service",
            tags: [CODE_REPO_TAG, CODE_REPO_DECISION_TAG],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "decision",
                    audience: ["technical"],
                    superseded: true,
                    validUntil: Date.now() - 1000,
                },
            },
        });
        expect(memId).toBeTruthy();

        const result = await engine.buildContext("orders service datastore", {
            domains: [CODE_REPO_DOMAIN_ID],
            budgetTokens: 1000,
        });
        // Superseded entry should be filtered out entirely by isEntryValid
        expect(result.memories.find((m) => m.id === memId)).toBeUndefined();
    });
});
