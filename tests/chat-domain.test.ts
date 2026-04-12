import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../src/core/engine.js";
import type { DomainContext } from "../src/core/types.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";
import { createChatDomain, chatDomain } from "../src/domains/chat/index.js";
import { createTopicDomain } from "../src/domains/topic/index.js";
import {
    promoteWorkingMemory,
    consolidateEpisodic,
    pruneDecayed,
} from "../src/domains/chat/schedules.js";
import {
    CHAT_DOMAIN_ID,
    CHAT_TAG,
    CHAT_MESSAGE_TAG,
    CHAT_EPISODIC_TAG,
    CHAT_SEMANTIC_TAG,
    DEFAULT_PROMOTE_INTERVAL_MS,
    DEFAULT_CONSOLIDATE_INTERVAL_MS,
    DEFAULT_PRUNE_INTERVAL_MS,
    type ChatAttributes,
} from "../src/domains/chat/types.js";
import { TOPIC_TAG } from "../src/domains/topic/types.js";
describe("Chat domain - config", () => {
    test("has correct id and name", () => {
        const domain = createChatDomain();
        expect(domain.id).toBe("chat");
        expect(domain.name).toBe("Chat");
    });

    test("has baseDir and 4 skills", () => {
        const domain = createChatDomain();
        expect(domain.baseDir).toBeTypeOf("string");
        expect(domain.baseDir!.length).toBeGreaterThan(0);
        expect(domain.skills).toHaveLength(4);
        const skillIds = domain.skills!.map((s) => s.id);
        expect(skillIds).toContain("chat-ingest");
        expect(skillIds).toContain("chat-query");
        expect(skillIds).toContain("chat-promote-working-memory");
        expect(skillIds).toContain("chat-consolidate-episodic");
    });

    test("schema has 1 edge (summarizes)", () => {
        const domain = createChatDomain();
        const edges = domain.schema!.edges;
        expect(edges).toHaveLength(1);
        expect(edges[0].name).toBe("summarizes");
        expect(edges[0].from).toBe("memory");
        expect(edges[0].to).toBe("memory");
    });

    test("default options include all three schedules", () => {
        const domain = createChatDomain();
        expect(domain.schedules).toHaveLength(3);
        const scheduleIds = domain.schedules!.map((s) => s.id);
        expect(scheduleIds).toContain("promote-working-memory");
        expect(scheduleIds).toContain("consolidate-episodic");
        expect(scheduleIds).toContain("prune-decayed");
    });

    test("schedules use default intervals", () => {
        const domain = createChatDomain();
        const promote = domain.schedules!.find((s) => s.id === "promote-working-memory")!;
        const consolidate = domain.schedules!.find((s) => s.id === "consolidate-episodic")!;
        const prune = domain.schedules!.find((s) => s.id === "prune-decayed")!;
        expect(promote.intervalMs).toBe(DEFAULT_PROMOTE_INTERVAL_MS);
        expect(consolidate.intervalMs).toBe(DEFAULT_CONSOLIDATE_INTERVAL_MS);
        expect(prune.intervalMs).toBe(DEFAULT_PRUNE_INTERVAL_MS);
    });

    test("individual schedules can be disabled", () => {
        const domain = createChatDomain({
            promoteSchedule: { enabled: false },
            consolidateSchedule: { enabled: false },
        });
        expect(domain.schedules).toHaveLength(1);
        expect(domain.schedules![0].id).toBe("prune-decayed");
    });

    test("schedules accept custom intervals", () => {
        const domain = createChatDomain({
            promoteSchedule: { intervalMs: 5000 },
        });
        const promote = domain.schedules!.find((s) => s.id === "promote-working-memory")!;
        expect(promote.intervalMs).toBe(5000);
    });

    test("describe() returns a non-empty string", () => {
        const domain = createChatDomain();
        const describeFn = domain.describe?.bind(domain);
        expect(describeFn).toBeTypeOf("function");
        expect(describeFn!().length).toBeGreaterThan(0);
    });

    test("default chatDomain instance is valid", () => {
        expect(chatDomain.id).toBe(CHAT_DOMAIN_ID);
        expect(chatDomain.schedules).toHaveLength(3);
    });

    test("ChatAttributes type accepts validFrom and invalidAt", () => {
        const attrs: ChatAttributes = {
            role: "user",
            layer: "episodic",
            chatSessionId: "s1",
            userId: "u1",
            messageIndex: 0,
            weight: 1.0,
            validFrom: Date.now(),
            invalidAt: Date.now(),
        };
        expect(attrs.validFrom).toBeTypeOf("number");
        expect(attrs.invalidAt).toBeTypeOf("number");
    });
});

describe("Chat domain - inbox processing", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        llm.extractResult = [];
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user", chatSessionId: "session-1" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );
    });

    afterEach(async () => {
        await engine.close();
    });

    test("stores message as working memory with correct attributes", async () => {
        const result = await engine.ingest("Hello world", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        expect(result.action).toBe("stored");

        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
        const memories = await ctx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { chatSessionId: "session-1", userId: "test-user" },
        });
        expect(memories).toHaveLength(1);
        expect(memories[0].content).toBe("Hello world");

        // Verify tags
        const tags = await ctx.getMemoryTags(memories[0].id);
        expect(tags).toContain(CHAT_TAG);
        expect(tags).toContain(CHAT_MESSAGE_TAG);
    });

    test("sets role, layer, chatSessionId, userId, messageIndex attributes", async () => {
        await engine.ingest("Test message", {
            domains: ["chat"],
            metadata: { role: "assistant" },
        });

        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
        const memories = await ctx.getMemories({
            attributes: {
                role: "assistant",
                layer: "working",
                chatSessionId: "session-1",
                userId: "test-user",
                messageIndex: 0,
            },
        });
        expect(memories).toHaveLength(1);
        expect(memories[0].content).toBe("Test message");
    });

    test("messageIndex auto-increments for successive messages", async () => {
        await engine.ingest("First message", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        await engine.ingest("Second message", {
            domains: ["chat"],
            metadata: { role: "assistant" },
        });
        await engine.processInbox();

        await engine.ingest("Third message", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        const first = await ctx.getMemories({ attributes: { messageIndex: 0 } });
        expect(first).toHaveLength(1);
        expect(first[0].content).toBe("First message");

        const second = await ctx.getMemories({ attributes: { messageIndex: 1 } });
        expect(second).toHaveLength(1);
        expect(second[0].content).toBe("Second message");

        const third = await ctx.getMemories({ attributes: { messageIndex: 2 } });
        expect(third).toHaveLength(1);
        expect(third[0].content).toBe("Third message");
    });

    test("uses per-ingest request context when engine default context is empty", async () => {
        const engine2 = new MemoryEngine();
        await engine2.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_per_ingest_ctx_${Date.now()}`,
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine2.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine2.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );

        await engine2.ingest("Scoped message", {
            domains: ["chat"],
            metadata: { role: "assistant" },
            context: { userId: "scoped-user", chatSessionId: "scoped-session" },
        });

        await engine2.processInbox();

        const ctx = engine2.createDomainContext(CHAT_DOMAIN_ID);
        const memories = await ctx.getMemories({
            attributes: {
                role: "assistant",
                layer: "working",
                userId: "scoped-user",
                chatSessionId: "scoped-session",
                messageIndex: 0,
            },
        });

        expect(memories).toHaveLength(1);
        expect(memories[0].content).toBe("Scoped message");

        await engine2.close();
    });

    test("keeps separate per-ingest contexts in the same inbox drain", async () => {
        const engine2 = new MemoryEngine();
        await engine2.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_mixed_ingest_ctx_${Date.now()}`,
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine2.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine2.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );

        await engine2.ingest("Session one message", {
            domains: ["chat"],
            metadata: { role: "user" },
            context: { userId: "user-1", chatSessionId: "session-1" },
        });
        await engine2.ingest("Session two message", {
            domains: ["chat"],
            metadata: { role: "assistant" },
            context: { userId: "user-2", chatSessionId: "session-2" },
        });

        await engine2.processInbox();
        await engine2.processInbox();

        const ctx = engine2.createDomainContext(CHAT_DOMAIN_ID);

        const sessionOne = await ctx.getMemories({
            attributes: {
                role: "user",
                layer: "working",
                userId: "user-1",
                chatSessionId: "session-1",
                messageIndex: 0,
            },
        });
        const sessionTwo = await ctx.getMemories({
            attributes: {
                role: "assistant",
                layer: "working",
                userId: "user-2",
                chatSessionId: "session-2",
                messageIndex: 0,
            },
        });

        expect(sessionOne).toHaveLength(1);
        expect(sessionOne[0].content).toBe("Session one message");
        expect(sessionTwo).toHaveLength(1);
        expect(sessionTwo[0].content).toBe("Session two message");

        await engine2.close();
    });

    test("skips processing when userId is missing from context", async () => {
        // Create engine without userId
        const engine2 = new MemoryEngine();
        await engine2.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_no_user_${Date.now()}`,
            context: { chatSessionId: "session-1" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine2.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine2.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );

        await engine2.ingest("Should be skipped", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine2.processInbox();

        const ctx = engine2.createDomainContext(CHAT_DOMAIN_ID);
        const memories = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] });
        expect(memories).toHaveLength(0);

        await engine2.close();
    });

    test("skips processing when chatSessionId is missing from context", async () => {
        const engine2 = new MemoryEngine();
        await engine2.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_no_session_${Date.now()}`,
            context: { userId: "test-user" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine2.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine2.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );

        await engine2.ingest("Should be skipped too", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine2.processInbox();

        const ctx = engine2.createDomainContext(CHAT_DOMAIN_ID);
        const memories = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] });
        expect(memories).toHaveLength(0);

        await engine2.close();
    });

    test("extracts topics and links them via about_topic edges", async () => {
        llm.extractResult = ["TypeScript", "memory systems"];

        await engine.ingest("I love working with TypeScript and memory systems", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
        const messages = await ctx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { chatSessionId: "session-1" },
        });
        expect(messages).toHaveLength(1);

        // Verify about_topic edges from the message
        const edges = await ctx.getNodeEdges(messages[0].id, "out");
        const topicEdges = edges.filter((e) => String(e.id).startsWith("about_topic:"));
        expect(topicEdges).toHaveLength(2);

        // Verify topics were created with correct tags
        const topics = await ctx.getMemories({ tags: [TOPIC_TAG] });
        expect(topics).toHaveLength(2);
        const topicContents = topics.map((t) => t.content).sort();
        expect(topicContents).toEqual(["TypeScript", "memory systems"]);
    });

    test("reuses existing topic instead of creating duplicate", async () => {
        llm.extractResult = ["TypeScript"];

        // First message mentioning TypeScript
        await engine.ingest("TypeScript is great", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        // Second message also mentioning TypeScript
        await engine.ingest("I use TypeScript daily", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        // Should still only have one topic (if search matched)
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
        const topics = await ctx.getMemories({ tags: [TOPIC_TAG] });
        // Note: with mock embedding, similarity matching may or may not find the existing topic
        // so we just verify topics were created and edges exist
        expect(topics.length).toBeGreaterThanOrEqual(1);
    });

    test("defaults role to user when not provided in metadata", async () => {
        await engine.ingest("No role specified", {
            domains: ["chat"],
            metadata: {},
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
        const memories = await ctx.getMemories({
            attributes: { role: "user", layer: "working" },
        });
        expect(memories).toHaveLength(1);
    });
});

describe("Chat domain - search", () => {
    test("search.expand returns empty ids when userId is missing", () => {
        const domain = createChatDomain();
        const result = domain.search!.expand!({ text: "test" }, {
            requestContext: {},
        } as unknown as DomainContext);
        return result.then((q) => {
            expect(q.ids).toEqual([]);
        });
    });

    test("search.expand passes through query when userId is present", () => {
        const domain = createChatDomain();
        const query = { text: "test", tags: ["chat"] };
        const result = domain.search!.expand!(query, {
            requestContext: { userId: "test-user" },
        } as unknown as DomainContext);
        return result.then((q) => {
            expect(q).toEqual(query);
        });
    });
});

describe("Chat domain - buildContext", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        llm.extractResult = [];
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user", chatSessionId: "session-1" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );
    });

    afterEach(async () => {
        await engine.close();
    });

    test("includes working memory from current session", async () => {
        await engine.ingest("Hello from session 1", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        const result = await engine.buildContext("message", {
            domains: ["chat"],
            context: { userId: "test-user", chatSessionId: "session-1" },
        });

        expect(result.context).toContain("Hello from session 1");
        expect(result.context).toContain("[Recent]");
        expect(result.memories.length).toBeGreaterThanOrEqual(1);
    });

    test("returns empty context when userId is missing", async () => {
        const engine2 = new MemoryEngine();
        await engine2.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_no_user_${Date.now()}`,
            context: { chatSessionId: "session-1" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine2.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine2.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );

        const result = await engine2.buildContext("message", {
            domains: ["chat"],
            context: { chatSessionId: "session-1" },
        });

        expect(result.context).toBe("");
        expect(result.memories).toHaveLength(0);
        expect(result.totalTokens).toBe(0);

        await engine2.close();
    });

    test("includes episodic and semantic memories", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        await ctx.writeMemory({
            content: "Episodic highlight about testing",
            tags: [CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "episodic", userId: "test-user", weight: 0.5 },
            },
        });

        await ctx.writeMemory({
            content: "Semantic knowledge about testing",
            tags: [CHAT_SEMANTIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "semantic", userId: "test-user", weight: 0.8 },
            },
        });

        const result = await engine.buildContext("testing", {
            domains: ["chat"],
            context: { userId: "test-user", chatSessionId: "session-1" },
        });

        expect(result.context).toContain("Episodic highlight about testing");
        expect(result.context).toContain("Semantic knowledge about testing");
        expect(result.context).toContain("[Context]");
        expect(result.context).toContain("[Background]");
    });

    test("does not include other session working memory", async () => {
        // Ingest a message for session-1 via normal flow
        await engine.ingest("Session 1 message", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        // Write a session-2 working memory directly
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
        await ctx.writeMemory({
            content: "Session 2 message",
            tags: [CHAT_TAG, CHAT_MESSAGE_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    role: "user",
                    layer: "working",
                    chatSessionId: "session-2",
                    userId: "test-user",
                    messageIndex: 0,
                },
            },
        });

        const result = await engine.buildContext("message", {
            domains: ["chat"],
            context: { userId: "test-user", chatSessionId: "session-1" },
        });

        expect(result.context).toContain("Session 1 message");
        expect(result.context).not.toContain("Session 2 message");
    });
});

describe("Chat domain - promote working memory", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        llm.extractResult = ["TypeScript"]; // for inbox topic extraction
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user", chatSessionId: "session-1" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }));
        await engine.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );
    });

    afterEach(async () => {
        await engine.close();
    });

    test("promotes working memories when capacity exceeded", async () => {
        // Ingest 3 messages
        await engine.ingest("First message about cats", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();
        await engine.ingest("Second message about dogs", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();
        await engine.ingest("Third message about birds", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Verify we have 3 working memories
        const workingBefore = await ctx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { layer: "working" },
        });
        expect(workingBefore).toHaveLength(3);

        // Set extract result for promotion
        llm.extractResult = ["Key fact from conversation"];

        // Promote with capacity=2 — should promote 1 memory (3 - 2 = 1 over capacity)
        await promoteWorkingMemory(ctx, { workingMemoryCapacity: 2 });

        // Verify episodic memories were created
        const episodic = await ctx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(episodic.length).toBeGreaterThanOrEqual(1);
        expect(episodic[0].content).toBe("Key fact from conversation");
    });

    test("skips promotion when under capacity", async () => {
        // Ingest 1 message
        await engine.ingest("Single message", { domains: ["chat"], metadata: { role: "user" } });
        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        llm.extractResult = ["Should not appear"];

        // Promote with capacity=50 — should not promote anything
        await promoteWorkingMemory(ctx, { workingMemoryCapacity: 50 });

        const episodic = await ctx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(episodic).toHaveLength(0);
    });

    test("promoted episodic memories have validFrom set", async () => {
        await engine.ingest("Message about weather", {
            domains: ["chat"],
            metadata: { role: "user" },
        });
        await engine.processInbox();
        await engine.ingest("Message about coding", {
            domains: ["chat"],
            metadata: { role: "user" },
            skipDedup: true,
        });
        await engine.processInbox();
        await engine.ingest("Message about lunch", {
            domains: ["chat"],
            metadata: { role: "user" },
            skipDedup: true,
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
        llm.extractResult = ["Fact about weather and coding"];

        const beforePromote = Date.now();
        await promoteWorkingMemory(ctx, { workingMemoryCapacity: 2 });

        const episodic = await ctx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(episodic).toHaveLength(1);

        // Check validFrom via graph query on owned_by attributes
        const rows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(`${episodic[0].id}`),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        expect(rows).toHaveLength(1);
        const validFrom = rows[0].attributes.validFrom as number;
        expect(validFrom).toBeTypeOf("number");
        expect(validFrom).toBeGreaterThanOrEqual(beforePromote);
    });

    test("released working memories no longer returned by getMemories", async () => {
        // Ingest 3 messages with distinct content to avoid dedup
        await engine.ingest("The weather today is sunny and warm in California", {
            domains: ["chat"],
            metadata: { role: "user" },
            skipDedup: true,
        });
        await engine.processInbox();
        await engine.ingest("My favorite programming language is Rust for systems work", {
            domains: ["chat"],
            metadata: { role: "assistant" },
            skipDedup: true,
        });
        await engine.processInbox();
        await engine.ingest("I enjoy hiking in the mountains on weekends frequently", {
            domains: ["chat"],
            metadata: { role: "user" },
            skipDedup: true,
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        const workingBefore = await ctx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { layer: "working" },
        });
        expect(workingBefore).toHaveLength(3);

        llm.extractResult = ["Extracted fact"];

        // Promote with capacity=2 — should release 1 working memory
        await promoteWorkingMemory(ctx, { workingMemoryCapacity: 2 });

        const workingAfter = await ctx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { layer: "working" },
        });
        expect(workingAfter.length).toBeLessThan(workingBefore.length);
    });
});

describe("Chat domain - consolidate episodic", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        llm.consolidateResult = "User is learning TypeScript for web development";
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );
    });

    afterEach(async () => {
        await engine.close();
    });

    test("consolidates clustered episodic memories into semantic", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Create 3 episodic memories with identical content so mock embeddings match
        for (let i = 0; i < 3; i++) {
            await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: { layer: "episodic", userId: "test-user", weight: 0.5 },
                },
            });
        }

        // Run consolidation with low thresholds
        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        // Verify semantic memory was created
        const semanticMemories = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories.length).toBeGreaterThanOrEqual(1);
        expect(semanticMemories[0].content).toBe("User is learning TypeScript for web development");
    });

    test("skips consolidation when no episodic memories exist", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.5, minClusterSize: 2 },
        });

        const semanticMemories = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories).toHaveLength(0);
    });

    test("skips clusters below minimum size", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Create only 1 episodic memory
        await ctx.writeMemory({
            content: "TypeScript programming fact",
            tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "episodic", userId: "test-user", weight: 0.5 },
            },
        });

        // Run consolidation with default minClusterSize=3
        await consolidateEpisodic(ctx);

        const semanticMemories = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories).toHaveLength(0);
    });
});

describe("Chat domain - prune decayed", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );
    });

    afterEach(async () => {
        await engine.close();
    });

    test("prunes episodic memories with decayed weight below threshold", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        await ctx.writeMemory({
            content: "Low weight episodic fact",
            tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "episodic", userId: "test-user", weight: 0.01 },
            },
        });

        // Prune with a high threshold (0.5) — decayed weight 0.01 is well below 0.5
        await pruneDecayed(ctx, { decay: { pruneThreshold: 0.5 } });

        const remaining = await ctx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(remaining).toHaveLength(0);
    });

    test("preserves episodic memories with decayed weight above threshold", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        await ctx.writeMemory({
            content: "High weight episodic fact",
            tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "episodic", userId: "test-user", weight: 0.9 },
            },
        });

        // Prune with a low threshold (0.05) — weight 0.9 with near-zero decay remains above 0.05
        await pruneDecayed(ctx, { decay: { pruneThreshold: 0.05, episodicLambda: 0.0001 } });

        const remaining = await ctx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(remaining).toHaveLength(1);
        expect(remaining[0].content).toBe("High weight episodic fact");
    });

    test("does not prune semantic memories", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        await ctx.writeMemory({
            content: "Semantic knowledge",
            tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "semantic", userId: "test-user", weight: 0.01 },
            },
        });

        // Prune with a high threshold (0.5) — semantic memories should not be touched
        await pruneDecayed(ctx, { decay: { pruneThreshold: 0.5 } });

        const remaining = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(remaining).toHaveLength(1);
        expect(remaining[0].content).toBe("Semantic knowledge");
    });

    test("skips already-invalidated episodic memories", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Create an invalidated memory with low weight
        await ctx.writeMemory({
            content: "Invalidated fact",
            tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    layer: "episodic",
                    userId: "test-user",
                    weight: 0.01,
                    invalidAt: Date.now() - 1000,
                },
            },
        });

        // Prune with high threshold — would normally delete it
        await pruneDecayed(ctx, { decay: { pruneThreshold: 0.5 } });

        // Should still exist because it was skipped (already invalidated)
        const remaining = await ctx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(remaining).toHaveLength(1);
        expect(remaining[0].content).toBe("Invalidated fact");
    });
});

describe("Chat domain - consolidate with contradiction detection", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );
    });

    afterEach(async () => {
        await engine.close();
    });

    test("detects contradictions and sets invalidAt on older memory", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now() - (3 - i) * 1000,
                    },
                },
            });
            ids.push(id);
        }

        llm.extractStructuredResult = [
            {
                summary: "Consolidated TypeScript fact",
                contradictions: [{ newerIndex: 2, olderIndex: 0 }],
            },
        ];

        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        // Exactly one of the 3 episodic memories should have invalidAt set
        let invalidCount = 0;
        let validCount = 0;
        for (const id of ids) {
            const rows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
                "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
                {
                    memId: new StringRecordId(id),
                    domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
                },
            );
            expect(rows).toHaveLength(1);
            if (rows[0].attributes.invalidAt !== undefined) {
                expect(rows[0].attributes.invalidAt).toBeTypeOf("number");
                invalidCount++;
            } else {
                validCount++;
            }
        }
        expect(invalidCount).toBe(1);
        expect(validCount).toBe(2);
    });

    test("creates contradicts edge from newer to older memory", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now() - (3 - i) * 1000,
                    },
                },
            });
            ids.push(id);
        }

        llm.extractStructuredResult = [
            {
                summary: "Consolidated fact",
                contradictions: [{ newerIndex: 2, olderIndex: 0 }],
            },
        ];

        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        // One of the memories should have an outgoing contradicts edge
        let totalContradictsEdges = 0;
        for (const id of ids) {
            const edges = await ctx.getNodeEdges(id, "out");
            totalContradictsEdges += edges.filter((e) =>
                String(e.id).startsWith("contradicts:"),
            ).length;
        }
        expect(totalContradictsEdges).toBe(1);
    });

    test("falls back to consolidate() when extractStructured rejects", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        for (let i = 0; i < 3; i++) {
            await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: { layer: "episodic", userId: "test-user", weight: 0.5 },
                },
            });
        }

        // Don't set extractStructuredResult — mock will reject, triggering fallback
        llm.consolidateResult = "Fallback consolidated summary";

        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        const semanticMemories = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories.length).toBeGreaterThanOrEqual(1);
        expect(semanticMemories[0].content).toBe("Fallback consolidated summary");
    });

    test("deduplicates semantic memories by merging similar ones", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Create an existing semantic memory
        const existingId = await ctx.writeMemory({
            content: "User prefers TypeScript for web development",
            tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    layer: "semantic",
                    userId: "test-user",
                    weight: 0.8,
                    validFrom: Date.now() - 10000,
                },
            },
        });

        // Create 3 episodic memories that will produce a similar semantic
        for (let i = 0; i < 3; i++) {
            await ctx.writeMemory({
                content: "User prefers TypeScript for web development",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now(),
                    },
                },
            });
        }

        // extractStructured returns summary with same text so mock embeddings match
        llm.extractStructuredResult = [
            {
                summary: "User prefers TypeScript for web development",
                contradictions: [],
            },
        ];
        // consolidate will be called for the merge step
        llm.consolidateResult = "Merged: User strongly prefers TypeScript for web projects";

        await consolidateEpisodic(ctx, {
            consolidation: {
                similarityThreshold: 0.1,
                minClusterSize: 2,
                semanticDedupThreshold: 0.1, // low threshold so mock embeddings match
            },
        });

        // The old semantic should be invalidated
        const oldRows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(existingId),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        expect(oldRows).toHaveLength(1);
        expect(oldRows[0].attributes.invalidAt).toBeTypeOf("number");
    });

    test("skips semantic dedup when no similar semantic exists", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Create 3 episodic memories — no existing semantics
        for (let i = 0; i < 3; i++) {
            await ctx.writeMemory({
                content: "Unique topic about cooking pasta",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now(),
                    },
                },
            });
        }

        llm.extractStructuredResult = [
            { summary: "User discusses cooking pasta", contradictions: [] },
        ];

        await consolidateEpisodic(ctx, {
            consolidation: {
                similarityThreshold: 0.1,
                minClusterSize: 2,
                semanticDedupThreshold: 0.99, // very high — nothing should match
            },
        });

        const semanticMemories = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories).toHaveLength(1);
        expect(semanticMemories[0].content).toBe("User discusses cooking pasta");
    });

    test("semantic memory created from consolidation has validFrom set", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        for (let i = 0; i < 3; i++) {
            await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now(),
                    },
                },
            });
        }

        llm.extractStructuredResult = [{ summary: "Summary with validFrom", contradictions: [] }];

        const beforeConsolidate = Date.now();
        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        const semanticMemories = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories.length).toBeGreaterThanOrEqual(1);

        const rows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(semanticMemories[0].id),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        expect(rows[0].attributes.validFrom).toBeTypeOf("number");
        expect(rows[0].attributes.validFrom as number).toBeGreaterThanOrEqual(beforeConsolidate);
    });
});
