/**
 * Chat domain integration tests with real AI adapters.
 *
 * Uses ClaudeCliAdapter (haiku) for LLM and OnnxEmbeddingAdapter for embeddings.
 * LLM response quality is logged for the test runner (agent) to evaluate.
 *
 * Run with: bun test tests-integration/chat-domain-integration.test.ts --timeout 120000
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import { ClaudeCliAdapter } from "../src/adapters/llm/claude-cli.js";
import { OnnxEmbeddingAdapter } from "../src/adapters/onnx-embedding.js";
import { createChatDomain } from "../src/domains/chat/chat-domain.js";
import { topicDomain } from "../src/domains/topic/index.js";
import { userDomain } from "../src/domains/user/index.js";
import {
    CHAT_DOMAIN_ID,
    CHAT_MESSAGE_TAG,
    CHAT_EPISODIC_TAG,
    CHAT_SEMANTIC_TAG,
} from "../src/domains/chat/types.js";
import { TOPIC_DOMAIN_ID, TOPIC_TAG } from "../src/domains/topic/types.js";
import { USER_DOMAIN_ID, USER_TAG } from "../src/domains/user/types.js";
import {
    promoteWorkingMemory,
    consolidateEpisodic,
    pruneDecayed,
} from "../src/domains/chat/schedules.js";

const llm = new ClaudeCliAdapter({ model: "haiku" });
const embedding = new OnnxEmbeddingAdapter();

/** Drain all inbox items by calling processInbox until empty */
async function drainInbox(engine: MemoryEngine): Promise<void> {
    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }
}

// ---------------------------------------------------------------------------
// 1. Chat message ingestion with cross-domain interaction
// ---------------------------------------------------------------------------
describe("Chat message ingestion with cross-domain interaction (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_chat_ingest_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
            context: { userId: "test-user", chatSessionId: "session-1" },
        });
        await engine.registerDomain(createChatDomain());
        await engine.registerDomain(topicDomain);
        await engine.registerDomain(userDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("ingest chat messages, verify tags, attributes, and topic linking", async () => {
        const chatCtx = engine.createDomainContext(CHAT_DOMAIN_ID);
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);

        // Create a user node for cross-domain coexistence
        await userCtx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        // Ingest a user fact via user domain
        const factId = await userCtx.writeMemory({
            content: "The user is a backend developer specializing in TypeScript",
            tags: [`${USER_TAG}/expertise`],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await userCtx.graph.relate(factId, "about_user", "user:test-user", {
            domain: USER_DOMAIN_ID,
        });

        // Ingest chat messages
        const msg1 = await engine.ingest(
            "I have been working with Kubernetes for the past two years to orchestrate our microservices",
            { domains: [CHAT_DOMAIN_ID] },
        );
        expect(msg1.action).toBe("stored");
        expect(msg1.id).toBeTruthy();

        const msg2 = await engine.ingest(
            "We recently migrated from Docker Compose to Kubernetes in production",
            { domains: [CHAT_DOMAIN_ID] },
        );
        expect(msg2.action).toBe("stored");

        // Process inbox to trigger processInboxBatch for each message
        await drainInbox(engine);

        // Verify working memory attributes via search (returns ScoredMemory with domainAttributes)
        const workingSearch = await chatCtx.search({
            text: "Kubernetes",
            tags: [CHAT_MESSAGE_TAG],
            attributes: { userId: "test-user", chatSessionId: "session-1", layer: "working" },
        });
        // Also verify via getMemories for count
        const workingMemories = await chatCtx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { userId: "test-user", chatSessionId: "session-1", layer: "working" },
        });
        expect(workingMemories.length).toBe(2);

        // Verify messageIndex auto-increment using search results (which have domainAttributes)
        const indices = workingSearch.entries
            .filter((e) => e.domainAttributes[CHAT_DOMAIN_ID] != null)
            .map((e) => e.domainAttributes[CHAT_DOMAIN_ID].messageIndex as number)
            .sort();
        expect(indices.length).toBe(2);
        expect(indices).toEqual([0, 1]);

        console.log("[PASS] Chat messages ingested with correct tags and attributes");
        console.log(`  Working memories: ${workingMemories.length}`);
        console.log(`  Message indices: ${JSON.stringify(indices)}`);

        // Verify topics were extracted and linked via about_topic edges
        const graph = engine.getGraph();
        const msg1Topics = await graph.traverse(msg1.id!, "->about_topic->memory");
        console.log(`[TOPIC EXTRACTION] Message 1 linked to ${msg1Topics.length} topic(s)`);
        expect(msg1Topics.length).toBeGreaterThan(0);

        // Verify user domain facts coexist
        const userFacts = await userCtx.getMemories({ domains: [USER_DOMAIN_ID] });
        expect(userFacts.length).toBeGreaterThanOrEqual(1);
        expect(userFacts.some((f) => f.content.includes("backend developer"))).toBe(true);

        console.log("[PASS] Cross-domain coexistence: user fact and chat messages both present");
    });
});

// ---------------------------------------------------------------------------
// 2. Working memory promotion
// ---------------------------------------------------------------------------
describe("Working memory promotion (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_chat_promote_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
            context: { userId: "promote-user", chatSessionId: "session-promote" },
        });
        // Use low capacity to trigger promotion
        await engine.registerDomain(createChatDomain({ workingMemoryCapacity: 2 }));
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("promote working memory to episodic when capacity exceeded", async () => {
        const chatCtx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Ingest 4 messages to exceed capacity of 2
        const messages = [
            "I use Python for data analysis and machine learning projects",
            "Pandas and NumPy are my go-to libraries for data manipulation",
            "I also use scikit-learn for building classification models",
            "Recently I have been exploring PyTorch for deep learning experiments",
        ];

        for (const msg of messages) {
            await engine.ingest(msg, { domains: [CHAT_DOMAIN_ID] });
        }

        // Process inbox to apply chat domain processing
        await drainInbox(engine);

        // Verify all 4 are working memories
        const beforePromote = await chatCtx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { layer: "working", userId: "promote-user" },
        });
        expect(beforePromote.length).toBe(4);

        // Run promotion (capacity=2 means 2 oldest should be promoted)
        await promoteWorkingMemory(chatCtx, { workingMemoryCapacity: 2 });

        // Verify episodic memories were created
        const episodicMemories = await chatCtx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(episodicMemories.length).toBeGreaterThan(0);

        // Verify episodic attributes via search (ScoredMemory has domainAttributes)
        const episodicSearch = await chatCtx.search({
            text: "Python machine learning data",
            tags: [CHAT_EPISODIC_TAG],
        });
        const episodicEntries = episodicSearch.entries.filter((e) => {
            const attrs = e.domainAttributes[CHAT_DOMAIN_ID];
            return attrs && attrs.layer === "episodic";
        });
        console.log(`[PROMOTION] Created ${episodicMemories.length} episodic memories:`);
        for (const entry of episodicEntries) {
            const attrs = entry.domainAttributes[CHAT_DOMAIN_ID];
            console.log(`  weight=${String(attrs.weight)} "${entry.content.slice(0, 80)}..."`);
            expect(attrs.weight).toBe(1.0);
        }
        expect(episodicEntries.length).toBeGreaterThan(0);

        // Note: summarizes edges (episodic → working) are not checked here because
        // releaseOwnership deletes orphaned working memories and their edges within
        // promoteWorkingMemory itself. The semantic→episodic summarizes edges tested
        // in the lifecycle test do persist because episodic memories remain owned.

        // Verify ownership was released on promoted working memories
        const remainingWorking = await chatCtx.getMemories({
            tags: [CHAT_MESSAGE_TAG],
            attributes: { layer: "working", userId: "promote-user" },
        });
        expect(remainingWorking.length).toBeLessThanOrEqual(2);

        console.log(
            `[PASS] Promotion complete: ${remainingWorking.length} working memories remain (capacity=2)`,
        );
    });
});

// ---------------------------------------------------------------------------
// 3. Full lifecycle: ingest -> promote -> consolidate -> prune
// ---------------------------------------------------------------------------
describe("Full chat lifecycle (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_chat_lifecycle_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
            context: { userId: "lifecycle-user", chatSessionId: "session-lc" },
        });
        await engine.registerDomain(
            createChatDomain({
                workingMemoryCapacity: 2,
                consolidation: { similarityThreshold: 0.5, minClusterSize: 2 },
            }),
        );
        await engine.registerDomain(topicDomain);
        await engine.registerDomain(userDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("full lifecycle from ingestion through consolidation and pruning", async () => {
        const chatCtx = engine.createDomainContext(CHAT_DOMAIN_ID);
        const userCtx = engine.createDomainContext(USER_DOMAIN_ID);

        // Create user node and a user fact
        await userCtx.graph.createNodeWithId("user:lifecycle-user", { userId: "lifecycle-user" });
        await userCtx.writeMemory({
            content: "The user is a DevOps engineer at a startup",
            tags: [`${USER_TAG}/role`],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });

        // --- Phase 1: Ingest messages via engine (uses engine-level context) ---
        const messages = [
            "We use Terraform to manage our cloud infrastructure on AWS",
            "Our CI/CD pipeline runs on GitHub Actions with automated testing",
            "I set up monitoring using Prometheus and Grafana dashboards",
            "We also use Terraform modules for reusable infrastructure components",
            "Our AWS setup includes EKS clusters managed by Terraform",
            "Infrastructure as code is essential for our deployment workflow",
        ];
        for (const msg of messages) {
            await engine.ingest(msg, { domains: [CHAT_DOMAIN_ID] });
        }
        await drainInbox(engine);

        console.log("[LIFECYCLE] Phase 1: Ingested 6 messages");

        // --- Phase 2: Promote working memory ---
        await promoteWorkingMemory(chatCtx, { workingMemoryCapacity: 2 });

        const episodicAfterPromote = await chatCtx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        expect(episodicAfterPromote.length).toBeGreaterThan(0);
        console.log(
            `[LIFECYCLE] Phase 2: Promotion created ${episodicAfterPromote.length} episodic memories`,
        );

        // --- Phase 3: Consolidate episodic -> semantic ---
        await consolidateEpisodic(chatCtx, {
            consolidation: { similarityThreshold: 0.5, minClusterSize: 2 },
        });

        const semanticMemories = await chatCtx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });

        console.log(
            `[LIFECYCLE] Phase 3: Consolidation created ${semanticMemories.length} semantic memories`,
        );
        for (const mem of semanticMemories) {
            console.log(`  "${mem.content.slice(0, 100)}..."`);
        }

        // Verify summarizes edges on semantic memories
        if (semanticMemories.length > 0) {
            const graph = engine.getGraph();
            for (const mem of semanticMemories) {
                const sources = await graph.traverse(mem.id, "->summarizes->memory");
                expect(sources.length).toBeGreaterThan(0);
                console.log(`  Semantic ${mem.id} summarizes ${sources.length} episodic memories`);
            }
        }

        // --- Phase 4: Prune with aggressive lambda ---
        // Use a very high lambda so recently created episodic memories decay below threshold
        await pruneDecayed(chatCtx, {
            decay: { episodicLambda: 1000, pruneThreshold: 0.05 },
        });

        const episodicAfterPrune = await chatCtx.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });
        console.log(
            `[LIFECYCLE] Phase 4: After pruning, ${episodicAfterPrune.length} episodic memories remain`,
        );

        // --- Phase 5: Verify domain-scoped search isolation ---
        const chatSearch = await engine.search({
            mode: "graph",
            tags: [CHAT_MESSAGE_TAG, CHAT_EPISODIC_TAG, CHAT_SEMANTIC_TAG],
            domains: [CHAT_DOMAIN_ID],
        });
        const userSearch = await engine.search({
            mode: "graph",
            tags: [`${USER_TAG}/role`],
            domains: [USER_DOMAIN_ID],
        });
        const topicSearch = await engine.search({
            mode: "graph",
            tags: [TOPIC_TAG],
            domains: [TOPIC_DOMAIN_ID],
        });

        // Chat and user memories should not overlap
        const chatIds = new Set(chatSearch.entries.map((e) => e.id));
        const userIds = new Set(userSearch.entries.map((e) => e.id));
        for (const id of userIds) {
            expect(chatIds.has(id)).toBe(false);
        }

        console.log(
            `[LIFECYCLE] Domain isolation: chat=${chatSearch.entries.length}, user=${userSearch.entries.length}, topic=${topicSearch.entries.length}`,
        );
        console.log("[PASS] Full lifecycle complete with domain isolation verified");
    });
});

// ---------------------------------------------------------------------------
// 4. buildContext tiered retrieval + user isolation
// ---------------------------------------------------------------------------
describe("buildContext tiered retrieval + user isolation (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_chat_ctx_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(
            createChatDomain({
                workingMemoryCapacity: 50,
                consolidation: { similarityThreshold: 0.5, minClusterSize: 2 },
            }),
        );
        await engine.registerDomain(topicDomain);
        await engine.registerDomain(userDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("buildContext returns tiered sections and isolates users", async () => {
        const chatCtx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // --- Populate working memories for Alice (current session) ---
        await chatCtx.writeMemory({
            content: "Alice: I am adding authentication to my Next.js app using NextAuth",
            tags: [CHAT_MESSAGE_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    role: "user",
                    layer: "working",
                    userId: "alice",
                    chatSessionId: "alice-session",
                    messageIndex: 0,
                },
            },
        });
        await chatCtx.writeMemory({
            content: "Alice: My frontend stack includes Tailwind CSS and React components",
            tags: [CHAT_MESSAGE_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    role: "user",
                    layer: "working",
                    userId: "alice",
                    chatSessionId: "alice-session",
                    messageIndex: 1,
                },
            },
        });

        // --- Populate working memories for Bob (current session) ---
        await chatCtx.writeMemory({
            content:
                "Bob: I am setting up database replication for high availability with PostgreSQL",
            tags: [CHAT_MESSAGE_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    role: "user",
                    layer: "working",
                    userId: "bob",
                    chatSessionId: "bob-session",
                    messageIndex: 0,
                },
            },
        });
        await chatCtx.writeMemory({
            content: "Bob: We recently migrated from MySQL to PostgreSQL for better JSON support",
            tags: [CHAT_MESSAGE_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    role: "user",
                    layer: "working",
                    userId: "bob",
                    chatSessionId: "bob-session",
                    messageIndex: 1,
                },
            },
        });

        // --- Populate episodic memories for both users ---
        await chatCtx.writeMemory({
            content: "Alice prefers functional React components with custom hooks for reusability",
            tags: [CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "episodic", userId: "alice", weight: 1.0 },
            },
        });
        await chatCtx.writeMemory({
            content: "Alice uses Vitest and React Testing Library for frontend testing",
            tags: [CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "episodic", userId: "alice", weight: 1.0 },
            },
        });
        await chatCtx.writeMemory({
            content: "Bob optimizes SQL queries using EXPLAIN ANALYZE and proper indexing",
            tags: [CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "episodic", userId: "bob", weight: 1.0 },
            },
        });

        // --- Populate semantic memories ---
        await chatCtx.writeMemory({
            content:
                "Alice is a frontend developer who works extensively with React, Next.js, and Tailwind CSS",
            tags: [CHAT_SEMANTIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "semantic", userId: "alice", weight: 0.8 },
            },
        });
        await chatCtx.writeMemory({
            content: "Bob is a database engineer focused on PostgreSQL optimization and migration",
            tags: [CHAT_SEMANTIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: { layer: "semantic", userId: "bob", weight: 0.8 },
            },
        });

        // --- Build context for Alice ---
        const aliceContext = await engine.buildContext("frontend development with React", {
            domains: [CHAT_DOMAIN_ID],
            budgetTokens: 2000,
            context: { userId: "alice", chatSessionId: "alice-session" },
        });

        console.log("[BUILD CONTEXT - ALICE]");
        console.log(`  Total tokens: ${aliceContext.totalTokens}`);
        console.log(`  Memories: ${aliceContext.memories.length}`);
        console.log(`  Context:\n${aliceContext.context}`);

        // Alice's context should contain her content
        expect(aliceContext.context.length).toBeGreaterThan(0);
        expect(aliceContext.totalTokens).toBeLessThanOrEqual(2000);

        // Alice's context should NOT contain Bob's content
        const aliceLower = aliceContext.context.toLowerCase();
        expect(aliceLower).not.toContain("postgresql");
        expect(aliceLower).not.toContain("mysql");
        expect(aliceLower).not.toContain("database replication");

        // --- Build context for Bob ---
        const bobContext = await engine.buildContext("database optimization and SQL", {
            domains: [CHAT_DOMAIN_ID],
            budgetTokens: 2000,
            context: { userId: "bob", chatSessionId: "bob-session" },
        });

        console.log("[BUILD CONTEXT - BOB]");
        console.log(`  Total tokens: ${bobContext.totalTokens}`);
        console.log(`  Memories: ${bobContext.memories.length}`);
        console.log(`  Context:\n${bobContext.context}`);

        // Bob's context should contain his content
        expect(bobContext.context.length).toBeGreaterThan(0);
        expect(bobContext.totalTokens).toBeLessThanOrEqual(2000);

        // Bob's context should NOT contain Alice's content
        const bobLower = bobContext.context.toLowerCase();
        expect(bobLower).not.toContain("react");
        expect(bobLower).not.toContain("next.js");
        expect(bobLower).not.toContain("tailwind");

        // Verify sections exist where applicable
        if (aliceContext.context.includes("[Recent]")) {
            console.log("[PASS] Alice context has [Recent] section");
        }
        if (aliceContext.context.includes("[Context]")) {
            console.log("[PASS] Alice context has [Context] section (episodic)");
        }
        if (aliceContext.context.includes("[Background]")) {
            console.log("[PASS] Alice context has [Background] section (semantic)");
        }

        console.log("[PASS] User isolation verified: no data leakage between Alice and Bob");
    });
});
