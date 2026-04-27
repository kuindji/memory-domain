import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";
import { createUserDomain, userDomain } from "../src/domains/user/index.js";
import { topicDomain } from "../src/domains/topic/index.js";
import { USER_DOMAIN_ID, USER_TAG } from "../src/domains/user/types.js";
import { TOPIC_DOMAIN_ID, TOPIC_TAG } from "../src/domains/topic/types.js";
import { consolidateUserProfile } from "../src/domains/user/schedules.js";
import { mergeSimilarTopics } from "../src/domains/topic/schedules.js";
import type {
    DomainConfig,
    DomainContext,
    OwnedMemory,
    RequestContext,
    SearchQuery,
} from "../src/core/types.js";

// ---------------------------------------------------------------------------
// 1. Topic + User domain coexistence
// ---------------------------------------------------------------------------
describe("Topic + User domain coexistence", () => {
    let engine: MemoryEngine;
    let topicId: string;
    let userFactId: string;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
            context: { userId: "test-user" },
        });
        await engine.registerDomain(userDomain);
        await engine.registerDomain(topicDomain);

        // Create user node
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        await userCtx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        // Create a topic memory
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);
        topicId = await topicCtx.writeMemory({
            content: "TypeScript programming language",
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: "TypeScript",
                    status: "active",
                    mentionCount: 1,
                    lastMentionedAt: Date.now(),
                    createdBy: "test",
                },
            },
        });

        // Create a user fact linked to user and topic
        userFactId = await userCtx.writeMemory({
            content: "User is proficient in TypeScript",
            tags: [`${USER_TAG}/expertise`],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(userFactId, "about_user", "user:test-user", {
            domain: USER_DOMAIN_ID,
        });
        await userCtx.graph.relate(userFactId, "about_topic", topicId, { domain: USER_DOMAIN_ID });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("both domains register schemas without conflict", async () => {
        const registry = engine.getDomainRegistry();
        expect(registry.has(USER_DOMAIN_ID)).toBe(true);
        expect(registry.has(TOPIC_DOMAIN_ID)).toBe(true);

        // User node is retrievable
        const graph = engine.getGraph();
        const userNode = await graph.getNode("user:test-user");
        expect(userNode).toBeDefined();
        expect(userNode!.userId).toBe("test-user");

        // about_topic edge is traversable
        const topics = await graph.traverse(userFactId, "->about_topic->memory");
        expect(topics.length).toBe(1);
    });

    test("memories owned by different domains are independently searchable", async () => {
        // user fact is tagged with `user/expertise`, topic memory with `topic`
        const userResults = await engine.search({
            mode: "graph",
            tags: [`${USER_TAG}/expertise`],
            domains: [USER_DOMAIN_ID],
        });
        const topicResults = await engine.search({
            mode: "graph",
            tags: [TOPIC_TAG],
            domains: [TOPIC_DOMAIN_ID],
        });
        const bothResults = await engine.search({
            mode: "graph",
            tags: [`${USER_TAG}/expertise`, TOPIC_TAG],
            domains: [USER_DOMAIN_ID, TOPIC_DOMAIN_ID],
        });

        const userContents = userResults.entries.map((e) => e.content);
        const topicContents = topicResults.entries.map((e) => e.content);

        expect(userContents).toContain("User is proficient in TypeScript");
        expect(userContents).not.toContain("TypeScript programming language");

        expect(topicContents).toContain("TypeScript programming language");
        expect(topicContents).not.toContain("User is proficient in TypeScript");

        expect(bothResults.entries.length).toBe(
            userResults.entries.length + topicResults.entries.length,
        );
    });

    test("user fact linked to topic is traversable from both sides", async () => {
        const graph = engine.getGraph();

        // Fact -> topic
        const topicsFromFact = await graph.traverse(userFactId, "->about_topic->memory");
        expect(topicsFromFact.length).toBe(1);
        const topicNodeId = String((topicsFromFact[0] as { id: string }).id);
        const normalizedTopicId = topicId.startsWith("memory:")
            ? topicId.slice("memory:".length)
            : topicId;
        expect(topicNodeId === topicId || topicNodeId === normalizedTopicId).toBe(true);

        // Topic <- fact (reverse)
        const factsFromTopic = await graph.traverse(topicId, "<-about_topic<-memory");
        expect(factsFromTopic.length).toBe(1);

        // Fact -> user node
        const users = await graph.traverse(userFactId, "->about_user->user");
        expect(users.length).toBe(1);
    });

    test("merge and consolidation schedules do not interfere", async () => {
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);

        // Create a duplicate topic for merging
        await topicCtx.writeMemory({
            content: "TypeScript programming language",
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: "TS duplicate",
                    status: "active",
                    mentionCount: 0,
                    lastMentionedAt: Date.now(),
                    createdBy: "test",
                },
            },
        });

        // Create another user fact for consolidation
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        const mem2 = await userCtx.writeMemory({
            content: "User enjoys hiking",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(mem2, "about_user", "user:test-user", {
            domain: USER_DOMAIN_ID,
        });

        // Run both schedules
        await mergeSimilarTopics(topicCtx);

        const llm = engine["llm"] as MockLLMAdapter;
        llm.consolidateResult = "User knows TypeScript and enjoys hiking.";
        await consolidateUserProfile(userCtx);

        // Verify merge: one topic should be merged
        const topicSearch = await topicCtx.search({
            text: "TypeScript programming language",
            tags: [TOPIC_TAG],
        });
        const statuses = topicSearch.entries.map(
            (e) => e.domainAttributes[TOPIC_DOMAIN_ID]?.status,
        );
        expect(statuses).toContain("active");
        expect(statuses).toContain("merged");

        // Verify consolidation: profile summary created and linked
        const allUserMemories = await userCtx.getMemories({ domains: [USER_DOMAIN_ID] });
        const summary = allUserMemories.find(
            (m) => m.content === "User knows TypeScript and enjoys hiking.",
        );
        expect(summary).toBeDefined();

        const summaryEdges = await userCtx.getNodeEdges("user:test-user", "in");
        const summaryLinked = summaryEdges.some((e) => String(e.in) === summary!.id);
        expect(summaryLinked).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 2. Visibility with built-in domains
// ---------------------------------------------------------------------------
describe("Visibility with built-in domains", () => {
    let engine: MemoryEngine;
    let notesMemoryId: string;

    const notesDomain: DomainConfig = {
        id: "notes",
        name: "Notes",
        schema: { nodes: [], edges: [] },
        async processInboxBatch(_entries: OwnedMemory[], _context: DomainContext) {},
    };

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });

        // User domain with restricted visibility: can only see itself + topic
        const restrictedUser: DomainConfig = {
            ...createUserDomain().domain,
            settings: { includeDomains: [TOPIC_DOMAIN_ID] },
        };

        await engine.registerDomain(restrictedUser);
        await engine.registerDomain(topicDomain);
        await engine.registerDomain(notesDomain);

        // Ingest content for each domain
        await engine.ingest("user domain content", { domains: [USER_DOMAIN_ID] });
        await engine.ingest("topic domain content", { domains: [TOPIC_DOMAIN_ID] });
        const notesResult = await engine.ingest("notes domain content", { domains: ["notes"] });
        notesMemoryId = notesResult.id!;
    });

    afterEach(async () => {
        await engine.close();
    });

    test("user domain with includeDomains sees topic but not notes", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        const visible = ctx.getVisibleDomains();

        expect(visible).toContain(USER_DOMAIN_ID);
        expect(visible).toContain(TOPIC_DOMAIN_ID);
        expect(visible).not.toContain("notes");

        const searchResult = await ctx.search({ text: "content", mode: "fulltext" });
        const contents = searchResult.entries.map((e) => e.content);
        expect(contents).toContain("user domain content");
        expect(contents).toContain("topic domain content");
        expect(contents).not.toContain("notes domain content");
    });

    test("getNodeEdges on user node filters edges from non-visible domains", async () => {
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        await userCtx.graph.createNodeWithId("user:vis-user", { userId: "vis-user" });

        // Link a notes-owned memory to the user node
        await userCtx.graph.relate(notesMemoryId, "about_user", "user:vis-user", {
            domain: "notes",
        });

        // Link a user-owned memory to the user node
        const userFactId = await userCtx.writeMemory({
            content: "User fact for visibility test",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(userFactId, "about_user", "user:vis-user", {
            domain: USER_DOMAIN_ID,
        });

        // From user domain context, edges from notes should be filtered out
        const edges = await userCtx.getNodeEdges("user:vis-user", "in");
        const sourceIds = edges.map((e) => String(e.in));

        // User-owned memory edge should be present
        expect(
            sourceIds.some(
                (id) => id === userFactId || id.endsWith(userFactId.replace("memory:", "")),
            ),
        ).toBe(true);

        // Notes-owned memory edge should NOT be present
        expect(
            sourceIds.some(
                (id) => id === notesMemoryId || id.endsWith(notesMemoryId.replace("memory:", "")),
            ),
        ).toBe(false);
    });

    test("getMemory returns null for notes-domain memory from user context", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        const result = await ctx.getMemory(notesMemoryId);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 3. Request context propagation through engine operations
// ---------------------------------------------------------------------------
describe("Request context propagation", () => {
    let engine: MemoryEngine;
    let capturedExpandContext: RequestContext | undefined;
    let capturedBuildContextContext: RequestContext | undefined;

    const ctxTestDomain: DomainConfig = {
        id: "ctx-test",
        name: "Context Test",
        async processInboxBatch() {},
        search: {
            expand(query: SearchQuery, context: DomainContext) {
                capturedExpandContext = context.requestContext;
                return Promise.resolve(query);
            },
        },
        buildContext(_text: string, _budget: number, context: DomainContext) {
            capturedBuildContextContext = context.requestContext;
            return Promise.resolve({ context: "", memories: [], totalTokens: 0 });
        },
    };

    beforeEach(async () => {
        capturedExpandContext = undefined;
        capturedBuildContextContext = undefined;

        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
            context: { userId: "ctx-user", lang: "en" },
        });
        await engine.registerDomain(ctxTestDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    test("search passes merged context to expand hook", async () => {
        await engine.search({
            text: "test",
            domains: ["ctx-test"],
            context: { userId: "override", extra: 42 },
        });

        expect(capturedExpandContext).toEqual({ userId: "override", lang: "en", extra: 42 });
    });

    test("buildContext passes context to domain handler", async () => {
        await engine.buildContext("test query", {
            domains: ["ctx-test"],
            context: { userId: "bc-user" },
        });

        expect(capturedBuildContextContext).toEqual({ userId: "bc-user", lang: "en" });
    });

    test("buildContext fallback search does not propagate per-request context (known gap)", async () => {
        // Domain WITHOUT custom buildContext but WITH search.expand hook
        let fallbackCaptured: RequestContext | undefined;
        const fallbackDomain: DomainConfig = {
            id: "ctx-fallback",
            name: "Context Fallback",
            async processInboxBatch() {},
            search: {
                expand(query: SearchQuery, context: DomainContext) {
                    fallbackCaptured = context.requestContext;
                    return Promise.resolve(query);
                },
            },
        };
        await engine.registerDomain(fallbackDomain);

        await engine.buildContext("test", {
            domains: ["ctx-fallback"],
            context: { userId: "should-not-arrive" },
        });

        // Gap: buildContext's fallback this.search() call at engine.ts:681 does not pass context
        // The expand hook gets engine default context only, not per-request context
        expect(fallbackCaptured).toBeDefined();
        expect(fallbackCaptured!.userId).toBe("ctx-user"); // engine default, not 'should-not-arrive'
        expect(fallbackCaptured!.lang).toBe("en");
    });

    test.skip("ask propagates per-request context to domain buildContext (superseded by agentic contract)", async () => {
        // Under the agentic ask() contract, the engine dispatches to
        // adapter.runAgent and no longer calls domain.buildContext directly.
        // Context flows into domain operations only when the inner agent
        // invokes `build-context` via the CLI with explicit --meta-* flags;
        // the test harness needs a richer mock agent before this can assert.
    });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: user + topic + context
// ---------------------------------------------------------------------------
describe("End-to-end: user + topic + context", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;
    let tsTopicId: string;
    let rustTopicId: string;
    let tsFact: string;
    let rustFact: string;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        llm.consolidateResult = "E2E user knows TypeScript and Rust.";

        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm,
            embedding: new MockEmbeddingAdapter(),
            context: { userId: "e2e-user" },
        });
        await engine.registerDomain(userDomain);
        await engine.registerDomain(topicDomain);

        // Create user node
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        await userCtx.graph.createNodeWithId("user:e2e-user", { userId: "e2e-user" });

        // Create two dissimilar topics
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);
        tsTopicId = await topicCtx.writeMemory({
            content: "TypeScript static type checking compile time safety",
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: "TypeScript",
                    status: "active",
                    mentionCount: 2,
                    lastMentionedAt: Date.now(),
                    createdBy: "test",
                },
            },
        });

        rustTopicId = await topicCtx.writeMemory({
            content: "Rust memory safety ownership borrow checker systems programming",
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: "Rust",
                    status: "active",
                    mentionCount: 1,
                    lastMentionedAt: Date.now(),
                    createdBy: "test",
                },
            },
        });

        // Create user facts linked to user and topics
        tsFact = await userCtx.writeMemory({
            content: "User is proficient in TypeScript",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(tsFact, "about_user", "user:e2e-user", {
            domain: USER_DOMAIN_ID,
        });
        await userCtx.graph.relate(tsFact, "about_topic", tsTopicId, { domain: USER_DOMAIN_ID });

        rustFact = await userCtx.writeMemory({
            content: "User is learning Rust programming",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(rustFact, "about_user", "user:e2e-user", {
            domain: USER_DOMAIN_ID,
        });
        await userCtx.graph.relate(rustFact, "about_topic", rustTopicId, {
            domain: USER_DOMAIN_ID,
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("full lifecycle: ingest, link, search, consolidate, merge", async () => {
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);

        // 1. User node has incoming about_user edges from both facts
        const userEdges = await userCtx.getNodeEdges("user:e2e-user", "in");
        const incomingMemIds = userEdges.map((e) => String(e.in));
        expect(
            incomingMemIds.some(
                (id) => id === tsFact || id.includes(tsFact.replace("memory:", "")),
            ),
        ).toBe(true);
        expect(
            incomingMemIds.some(
                (id) => id === rustFact || id.includes(rustFact.replace("memory:", "")),
            ),
        ).toBe(true);

        // 2. Both facts have outgoing about_topic edges to their topics
        const graph = engine.getGraph();
        const tsTopics = await graph.traverse(tsFact, "->about_topic->memory");
        expect(tsTopics.length).toBe(1);
        const rustTopics = await graph.traverse(rustFact, "->about_topic->memory");
        expect(rustTopics.length).toBe(1);

        // 3. Search from user domain with context
        const userSearch = await engine.search({
            text: "TypeScript",
            domains: [USER_DOMAIN_ID],
            context: { userId: "e2e-user" },
        });
        expect(userSearch.entries.length).toBeGreaterThan(0);

        // 4. Search from topic domain
        const topicSearch = await engine.search({
            text: "TypeScript",
            domains: [TOPIC_DOMAIN_ID],
        });
        expect(topicSearch.entries.length).toBeGreaterThan(0);

        // 5. Run consolidation -> profile summary created
        await consolidateUserProfile(userCtx);

        const allUserMemories = await userCtx.getMemories({ domains: [USER_DOMAIN_ID] });
        const summary = allUserMemories.find((m) => m.content === llm.consolidateResult);
        expect(summary).toBeDefined();

        // Summary linked to user node
        const edgesAfter = await userCtx.getNodeEdges("user:e2e-user", "in");
        expect(edgesAfter.length).toBeGreaterThan(userEdges.length); // new summary edge

        // 6. Run merge -> TypeScript and Rust are dissimilar, both stay active
        await mergeSimilarTopics(topicCtx);

        const topicSearchAfterMerge = await topicCtx.search({
            text: "TypeScript Rust programming",
            tags: [TOPIC_TAG],
        });
        const topicEntries = topicSearchAfterMerge.entries.filter(
            (e) => e.domainAttributes[TOPIC_DOMAIN_ID] != null,
        );
        expect(topicEntries.length).toBeGreaterThanOrEqual(2);
        for (const entry of topicEntries) {
            expect(entry.domainAttributes[TOPIC_DOMAIN_ID].status).toBe("active");
        }
    });
});
