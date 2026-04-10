/**
 * Cross-feature integration tests with real AI adapters.
 *
 * Uses ClaudeCliAdapter (haiku) for LLM and OnnxEmbeddingAdapter for embeddings.
 * LLM response quality is logged for the test runner (agent) to evaluate.
 *
 * Run with: bun run test:integration
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import { ClaudeCliAdapter } from "../src/adapters/llm/claude-cli.js";
import { OnnxEmbeddingAdapter } from "../src/adapters/onnx-embedding.js";
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

const llm = new ClaudeCliAdapter({ model: "haiku" });
const embedding = new OnnxEmbeddingAdapter();

// ---------------------------------------------------------------------------
// 1. Topic + User domain coexistence (real adapters)
// ---------------------------------------------------------------------------
describe("Topic + User domain coexistence (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_coexist_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
            context: { userId: "test-user" },
        });
        await engine.registerDomain(userDomain);
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("ingest user facts and topic, link them, verify graph structure", async () => {
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);

        // Create user node
        await userCtx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        // Create a topic via writeMemory
        const topicId = await topicCtx.writeMemory({
            content:
                "TypeScript is a statically typed superset of JavaScript that compiles to plain JavaScript",
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: "TypeScript",
                    status: "active",
                    mentionCount: 3,
                    lastMentionedAt: Date.now(),
                    createdBy: "test",
                },
            },
        });
        expect(topicId).toBeTruthy();

        // Create user facts and link to user + topic
        const fact1Id = await userCtx.writeMemory({
            content:
                "The user has 5 years of experience with TypeScript and uses it daily for backend development",
            tags: [`${USER_TAG}/expertise`],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(fact1Id, "about_user", "user:test-user", {
            domain: USER_DOMAIN_ID,
        });
        await userCtx.graph.relate(fact1Id, "about_topic", topicId, { domain: USER_DOMAIN_ID });

        const fact2Id = await userCtx.writeMemory({
            content:
                "The user prefers strict TypeScript configuration with no-any and strict null checks enabled",
            tags: [`${USER_TAG}/preference`],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(fact2Id, "about_user", "user:test-user", {
            domain: USER_DOMAIN_ID,
        });
        await userCtx.graph.relate(fact2Id, "about_topic", topicId, { domain: USER_DOMAIN_ID });

        // Verify graph structure
        const userEdges = await userCtx.getNodeEdges("user:test-user", "in");
        expect(userEdges.length).toBe(2); // two facts linked to user

        const graph = engine.getGraph();
        const topicLinks1 = await graph.traverse(fact1Id, "->about_topic->memory");
        expect(topicLinks1.length).toBe(1);
        const topicLinks2 = await graph.traverse(fact2Id, "->about_topic->memory");
        expect(topicLinks2.length).toBe(1);

        console.log(
            "[PASS] Graph structure: user node has 2 incoming edges, both facts link to topic",
        );
    });

    test("vector search finds semantically similar content across domains", async () => {
        // Search for TypeScript-related content using real embeddings
        const results = await engine.search({
            text: "TypeScript programming experience",
            mode: "vector",
            limit: 5,
        });

        expect(results.entries.length).toBeGreaterThan(0);

        const contents = results.entries.map((e) => e.content);
        console.log("[VECTOR SEARCH] Results:");
        for (const entry of results.entries) {
            console.log(
                `  score=${entry.score.toFixed(3)} content="${entry.content.slice(0, 80)}..."`,
            );
        }

        // At least one result should be about TypeScript
        const hasRelevant = contents.some(
            (c) => c.toLowerCase().includes("typescript") || c.toLowerCase().includes("typed"),
        );
        expect(hasRelevant).toBe(true);
    });

    test("consolidation produces meaningful user profile summary", async () => {
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);

        await consolidateUserProfile(userCtx);

        // Find the summary by checking which memory has the profile-summary tag
        const profileSummaries = await userCtx.getMemories({
            tags: [`${USER_TAG}/profile-summary`],
            domains: [USER_DOMAIN_ID],
        });
        expect(profileSummaries.length).toBeGreaterThanOrEqual(1);
        const summary = profileSummaries[0];

        console.log("[LLM CONSOLIDATION] Profile summary:");
        console.log(`  "${summary.content}"`);

        // Summary should be linked to user node
        const edges = await userCtx.getNodeEdges("user:test-user", "in");
        const summaryLinked = edges.some((e) => String(e.in) === summary.id);
        expect(summaryLinked).toBe(true);
    });

    test("domain-scoped search returns only domain-owned memories", async () => {
        const userOnly = await engine.search({
            mode: "graph",
            tags: [
                `${USER_TAG}/expertise`,
                `${USER_TAG}/preference`,
                `${USER_TAG}/profile-summary`,
            ],
            domains: [USER_DOMAIN_ID],
        });
        const topicOnly = await engine.search({
            mode: "graph",
            tags: [TOPIC_TAG],
            domains: [TOPIC_DOMAIN_ID],
        });

        // User domain should have user facts + consolidation summary
        expect(userOnly.entries.length).toBeGreaterThanOrEqual(2);
        // Topic domain should have the topic memory
        expect(topicOnly.entries.length).toBeGreaterThanOrEqual(1);

        // No overlap
        const userIds = new Set(userOnly.entries.map((e) => e.id));
        const topicIds = new Set(topicOnly.entries.map((e) => e.id));
        for (const id of topicIds) {
            expect(userIds.has(id)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// 2. Visibility with built-in domains (real adapters)
// ---------------------------------------------------------------------------
describe("Visibility with built-in domains (real)", () => {
    let engine: MemoryEngine;
    let notesMemoryId: string;

    const notesDomain: DomainConfig = {
        id: "notes",
        name: "Notes",
        schema: { nodes: [], edges: [] },
        async processInboxBatch(_entries: OwnedMemory[], _context: DomainContext) {},
    };

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_vis_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });

        const restrictedUser: DomainConfig = {
            ...createUserDomain(),
            settings: { includeDomains: [TOPIC_DOMAIN_ID] },
        };

        await engine.registerDomain(restrictedUser);
        await engine.registerDomain(topicDomain);
        await engine.registerDomain(notesDomain);

        await engine.ingest("User domain: knowledge about functional programming paradigms", {
            domains: [USER_DOMAIN_ID],
        });
        await engine.ingest("Topic domain: Rust language features and memory safety", {
            domains: [TOPIC_DOMAIN_ID],
        });
        const notesResult = await engine.ingest(
            "Notes domain: meeting notes from yesterday about project timeline",
            { domains: ["notes"] },
        );
        notesMemoryId = notesResult.id!;
    });

    afterAll(async () => {
        await engine.close();
    });

    test("user domain sees only itself and topic, not notes", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        const visible = ctx.getVisibleDomains();

        expect(visible).toContain(USER_DOMAIN_ID);
        expect(visible).toContain(TOPIC_DOMAIN_ID);
        expect(visible).not.toContain("notes");

        // Vector search from user context should not find notes content
        const results = await ctx.search({
            text: "meeting notes project timeline",
            mode: "vector",
        });
        const contents = results.entries.map((e) => e.content);
        expect(contents.some((c) => c.includes("meeting notes"))).toBe(false);
    });

    test("getMemory returns null for notes-owned memory from user context", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        const result = await ctx.getMemory(notesMemoryId);
        expect(result).toBeNull();
    });

    test("getNodeEdges filters edges from non-visible domains", async () => {
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        await userCtx.graph.createNodeWithId("user:vis-user", { userId: "vis-user" });

        // Link notes memory and user memory to the user node
        await userCtx.graph.relate(notesMemoryId, "about_user", "user:vis-user", {
            domain: "notes",
        });

        const userFactId = await userCtx.writeMemory({
            content: "This user prefers vim keybindings",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(userFactId, "about_user", "user:vis-user", {
            domain: USER_DOMAIN_ID,
        });

        const edges = await userCtx.getNodeEdges("user:vis-user", "in");
        const sourceIds = edges.map((e) => String(e.in));

        // User memory should be present, notes memory should be filtered
        expect(
            sourceIds.some(
                (id) => id === userFactId || id.includes(userFactId.replace("memory:", "")),
            ),
        ).toBe(true);
        expect(
            sourceIds.some(
                (id) => id === notesMemoryId || id.includes(notesMemoryId.replace("memory:", "")),
            ),
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. Request context propagation (real adapters)
// ---------------------------------------------------------------------------
describe("Request context propagation (real)", () => {
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

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_ctx_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
            context: { userId: "ctx-user", lang: "en" },
        });
        await engine.registerDomain(ctxTestDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("search passes merged context to expand hook", async () => {
        capturedExpandContext = undefined;
        await engine.search({
            text: "test query",
            domains: ["ctx-test"],
            context: { userId: "override", extra: 42 },
        });

        expect(capturedExpandContext).toBeDefined();
        expect(capturedExpandContext!.userId).toBe("override");
        expect(capturedExpandContext!.lang).toBe("en");
        expect(capturedExpandContext!.extra).toBe(42);
    });

    test("buildContext passes context to domain handler", async () => {
        capturedBuildContextContext = undefined;
        await engine.buildContext("test query", {
            domains: ["ctx-test"],
            context: { userId: "bc-user" },
        });

        expect(capturedBuildContextContext).toBeDefined();
        expect(capturedBuildContextContext!.userId).toBe("bc-user");
        expect(capturedBuildContextContext!.lang).toBe("en");
    });

    test("buildContext fallback search does not propagate per-request context (known gap)", async () => {
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

        expect(fallbackCaptured).toBeDefined();
        expect(fallbackCaptured!.userId).toBe("ctx-user"); // engine default, not per-request
        expect(fallbackCaptured!.lang).toBe("en");
    });
});

// ---------------------------------------------------------------------------
// 4. End-to-end lifecycle (real adapters)
// ---------------------------------------------------------------------------
describe("End-to-end lifecycle (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_e2e_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
            context: { userId: "e2e-user" },
        });
        await engine.registerDomain(userDomain);
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("full lifecycle: ingest, link, search, consolidate, merge", async () => {
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);
        const topicCtx = engine.createDomainContext(TOPIC_DOMAIN_ID);

        // Create user
        await userCtx.graph.createNodeWithId("user:e2e-user", { userId: "e2e-user" });

        // Create two dissimilar topics
        const tsTopicId = await topicCtx.writeMemory({
            content:
                "TypeScript is a statically typed programming language that builds on JavaScript with type safety",
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

        const rustTopicId = await topicCtx.writeMemory({
            content:
                "Rust is a systems programming language focused on memory safety, concurrency, and performance without garbage collection",
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
        const tsFact = await userCtx.writeMemory({
            content:
                "The user has been writing TypeScript professionally for 4 years in Node.js backends",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(tsFact, "about_user", "user:e2e-user", {
            domain: USER_DOMAIN_ID,
        });
        await userCtx.graph.relate(tsFact, "about_topic", tsTopicId, { domain: USER_DOMAIN_ID });

        const rustFact = await userCtx.writeMemory({
            content: "The user started learning Rust last month and is building a CLI tool with it",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(rustFact, "about_user", "user:e2e-user", {
            domain: USER_DOMAIN_ID,
        });
        await userCtx.graph.relate(rustFact, "about_topic", rustTopicId, {
            domain: USER_DOMAIN_ID,
        });

        // 1. Verify graph links
        const userEdges = await userCtx.getNodeEdges("user:e2e-user", "in");
        expect(userEdges.length).toBe(2);

        // 2. Vector search for TypeScript-related content
        const tsSearch = await engine.search({
            text: "TypeScript experience",
            mode: "vector",
            domains: [USER_DOMAIN_ID],
            context: { userId: "e2e-user" },
        });
        expect(tsSearch.entries.length).toBeGreaterThan(0);
        console.log("[E2E SEARCH] TypeScript results:");
        for (const entry of tsSearch.entries) {
            console.log(`  score=${entry.score.toFixed(3)} "${entry.content.slice(0, 80)}..."`);
        }

        // 3. Consolidation
        await consolidateUserProfile(userCtx);

        const allUserMemories = await userCtx.getMemories({ domains: [USER_DOMAIN_ID] });
        // Should have: tsFact, rustFact, and a summary
        expect(allUserMemories.length).toBeGreaterThanOrEqual(3);

        // Find the summary (it's not one of the original facts)
        const summary = allUserMemories.find((m) => m.id !== tsFact && m.id !== rustFact);
        expect(summary).toBeDefined();

        console.log("[E2E CONSOLIDATION] Profile summary:");
        console.log(`  "${summary!.content}"`);

        // Summary should be linked to user node
        const edgesAfter = await userCtx.getNodeEdges("user:e2e-user", "in");
        expect(edgesAfter.length).toBeGreaterThan(userEdges.length);

        // 4. Topic merge - TypeScript and Rust are dissimilar, both should stay active
        await mergeSimilarTopics(topicCtx);

        const topicSearch = await topicCtx.search({
            text: "programming languages",
            tags: [TOPIC_TAG],
        });
        const topicEntries = topicSearch.entries.filter(
            (e) => e.domainAttributes[TOPIC_DOMAIN_ID] != null,
        );
        expect(topicEntries.length).toBeGreaterThanOrEqual(2);
        for (const entry of topicEntries) {
            expect(entry.domainAttributes[TOPIC_DOMAIN_ID].status).toBe("active");
        }

        console.log(
            "[E2E MERGE] Both TypeScript and Rust topics remain active (dissimilar content)",
        );
    });
});
