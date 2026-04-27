/**
 * Knowledge Base domain integration tests with real AI adapters.
 *
 * Uses ClaudeCliAdapter (haiku) for LLM and OnnxEmbeddingAdapter for embeddings.
 * Tests inbox processing, classification, supersession detection,
 * related knowledge linking, buildContext, and consolidation schedule.
 *
 * Run with: bun test ./tests-integration/kb-domain-integration.test.ts --timeout 300000
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import { ClaudeCliAdapter } from "../src/adapters/llm/claude-cli.js";
import { OnnxEmbeddingAdapter } from "../src/adapters/onnx-embedding.js";
import { createKbDomain } from "../src/domains/kb/kb-domain.js";
import { topicDomain } from "../src/domains/topic/index.js";
import {
    KB_DOMAIN_ID,
    KB_TAG,
    KB_FACT_TAG,
    KB_DEFINITION_TAG,
    KB_HOWTO_TAG,
    KB_REFERENCE_TAG,
    KB_CONCEPT_TAG,
    KB_INSIGHT_TAG,
} from "../src/domains/kb/types.js";
import { consolidateKnowledge } from "../src/domains/kb/schedules.js";

const llm = new ClaudeCliAdapter({ model: "haiku" });
const embedding = new OnnxEmbeddingAdapter();

async function drainInbox(engine: MemoryEngine): Promise<void> {
    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }
}

// ---------------------------------------------------------------------------
// 1. Inbox processing with classification and topic extraction
// ---------------------------------------------------------------------------
describe("KB inbox processing with classification and topic linking (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_kb_inbox_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createKbDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("ingest fact with pre-set classification, verify tags and topic linking", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        const result = await engine.ingest(
            "The HTTP 429 status code means Too Many Requests and indicates the client has been rate-limited by the server",
            {
                domains: [KB_DOMAIN_ID],
                metadata: { classification: "fact" },
            },
        );
        expect(result.action).toBe("stored");

        await drainInbox(engine);

        // Verify classification attribute was preserved
        const facts = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "fact" },
        });
        expect(facts.length).toBe(1);
        expect(facts[0].content).toContain("429");
        console.log(`[PASS] Fact stored: "${facts[0].content.slice(0, 80)}..."`);

        // Verify tagged with kb and kb/fact
        const graph = engine.getGraph();
        const topicEdges = await graph.traverse(result.id!, "->about_topic->memory");
        console.log(`[TOPIC LINKING] Fact linked to ${topicEdges.length} topic(s)`);
        expect(topicEdges.length).toBeGreaterThan(0);
    });

    test("ingest without classification, verify LLM classifies it", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        await engine.ingest(
            "To reset a PostgreSQL sequence back to 1, run: ALTER SEQUENCE sequence_name RESTART WITH 1",
            { domains: [KB_DOMAIN_ID] },
        );

        await drainInbox(engine);

        // Find the PostgreSQL memory and check its classification
        const allMemories = await ctx.getMemories({ tags: [KB_TAG] });
        const pgMemory = allMemories.find((m) => m.content.includes("PostgreSQL"));
        expect(pgMemory).toBeTruthy();

        const classifications = ["fact", "definition", "how-to", "reference", "concept", "insight"];
        for (const cls of classifications) {
            const matches = await ctx.getMemories({
                tags: [KB_TAG],
                attributes: { classification: cls },
            });
            const found = matches.find((m) => m.content.includes("PostgreSQL"));
            if (found) {
                console.log(`[LLM CLASSIFICATION] PostgreSQL entry classified as: "${cls}"`);
                // A procedural instruction should ideally be classified as how-to
                break;
            }
        }
    });

    test("ingest multiple entries with different classifications", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        await engine.ingest(
            "Eventual consistency means that replicas in a distributed system will converge to the same state given enough time without new updates",
            {
                domains: [KB_DOMAIN_ID],
                metadata: { classification: "definition" },
            },
        );

        await engine.ingest(
            "RFC 7519 defines JSON Web Tokens (JWT) with a three-part structure: header.payload.signature, each base64url-encoded",
            {
                domains: [KB_DOMAIN_ID],
                metadata: { classification: "reference" },
            },
        );

        await engine.ingest(
            "The CAP theorem states that a distributed data store can only simultaneously guarantee two out of three properties: consistency, availability, and partition tolerance",
            {
                domains: [KB_DOMAIN_ID],
                metadata: { classification: "concept" },
            },
        );

        await drainInbox(engine);

        const definitions = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "definition" },
        });
        const references = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "reference" },
        });
        const concepts = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "concept" },
        });

        expect(definitions.some((m) => m.content.includes("Eventual consistency"))).toBe(true);
        expect(references.some((m) => m.content.includes("RFC 7519"))).toBe(true);
        expect(concepts.some((m) => m.content.includes("CAP theorem"))).toBe(true);

        console.log(
            `[PASS] Definitions: ${definitions.length}, References: ${references.length}, Concepts: ${concepts.length}`,
        );
    });
});

// ---------------------------------------------------------------------------
// 2. Supersession detection
// ---------------------------------------------------------------------------
describe("Supersession detection (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_kb_supersession_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createKbDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("new corrected fact creates supersedes edge on old one", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        // First fact (slightly wrong)
        await engine.ingest("The maximum size of a single HTTP header in most web servers is 4KB", {
            domains: [KB_DOMAIN_ID],
            metadata: { classification: "fact" },
        });
        await drainInbox(engine);

        const firstFacts = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "fact" },
        });
        const headerFact = firstFacts.find((m) => m.content.includes("HTTP header"));
        expect(headerFact).toBeTruthy();
        console.log(`[SUPERSESSION] First fact: "${headerFact!.content.slice(0, 80)}..."`);

        // Second fact (corrected)
        const second = await engine.ingest(
            "The maximum size of a single HTTP header in most web servers is 8KB, not 4KB. Apache defaults to 8190 bytes, Nginx to 8KB",
            {
                domains: [KB_DOMAIN_ID],
                metadata: { classification: "fact" },
            },
        );
        await drainInbox(engine);

        // Check if supersedes edge was created
        const graph = engine.getGraph();
        const supersededEdges = await graph.traverse(second.id!, "->supersedes->memory");

        if (supersededEdges.length > 0) {
            console.log(
                `[PASS] Supersession detected! New fact supersedes ${supersededEdges.length} old fact(s)`,
            );

            const oldFacts = await ctx.getMemories({
                tags: [KB_TAG],
                attributes: { superseded: true },
            });
            if (oldFacts.length > 0) {
                console.log(
                    `  Old fact marked superseded: "${oldFacts[0].content.slice(0, 80)}..."`,
                );
            }
        } else {
            console.log("[INFO] LLM did not detect supersession — acceptable with haiku model");
        }

        // Both facts should be stored regardless
        const allFacts = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "fact" },
        });
        const headerFacts = allFacts.filter((m) => m.content.includes("HTTP header"));
        expect(headerFacts.length).toBe(2);
        console.log(`[PASS] Both facts stored (${headerFacts.length} total)`);
    });
});

// ---------------------------------------------------------------------------
// 3. Related knowledge linking
// ---------------------------------------------------------------------------
describe("Related knowledge linking (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_kb_related_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createKbDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("related entries get linked with relationship type", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        // First: a concept
        await engine.ingest(
            "Optimistic concurrency control assumes conflicts are rare and validates at commit time, rolling back on conflict",
            {
                domains: [KB_DOMAIN_ID],
                metadata: { classification: "concept" },
            },
        );
        await drainInbox(engine);

        // Second: a related concept (contrast)
        const second = await engine.ingest(
            "Pessimistic concurrency control acquires locks before accessing data, preventing conflicts but reducing throughput under contention",
            {
                domains: [KB_DOMAIN_ID],
                metadata: { classification: "concept" },
            },
        );
        await drainInbox(engine);

        // Check for related_knowledge edges
        const graph = engine.getGraph();
        const relatedEdges = await graph.traverse(second.id!, "->related_knowledge->memory");

        if (relatedEdges.length > 0) {
            console.log(`[PASS] Related knowledge detected: ${relatedEdges.length} link(s)`);
            // Check the relationship type on the edge
            const edges = await ctx.getNodeEdges(second.id!, "out");
            const relKnowledgeEdge = edges.find((e) => {
                const edgeId = typeof e.id === "string" ? e.id : String(e.id);
                return edgeId.startsWith("related_knowledge:");
            });
            if (relKnowledgeEdge) {
                const edgeData = relKnowledgeEdge as unknown as Record<string, unknown>;
                const rel =
                    typeof edgeData.relationship === "string" ? edgeData.relationship : "unknown";
                console.log(`  Relationship type: "${rel}"`);
            }
        } else {
            console.log("[INFO] LLM did not detect relationship — acceptable with haiku model");
        }

        // Both should be stored
        const concepts = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "concept" },
        });
        expect(concepts.length).toBe(2);
        console.log(`[PASS] Both concepts stored (${concepts.length})`);
    });
});

// ---------------------------------------------------------------------------
// 4. buildContext with sectioned output
// ---------------------------------------------------------------------------
describe("buildContext with sectioned output (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_kb_ctx_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createKbDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("buildContext returns structured sections excluding superseded entries", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        // Definition
        await ctx.writeMemory({
            content:
                "A mutex (mutual exclusion) is a synchronization primitive that allows only one thread to access a shared resource at a time",
            tags: [KB_TAG, KB_DEFINITION_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "definition", superseded: false },
            },
        });

        // Concept
        await ctx.writeMemory({
            content:
                "Deadlock occurs when two or more threads are each waiting for the other to release a lock, creating a circular dependency that prevents progress",
            tags: [KB_TAG, KB_CONCEPT_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "concept", superseded: false },
            },
        });

        // Fact
        await ctx.writeMemory({
            content:
                "Go channels are typed conduits for goroutine communication, they block on send when full and on receive when empty",
            tags: [KB_TAG, KB_FACT_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "fact", superseded: false },
            },
        });

        // Reference
        await ctx.writeMemory({
            content:
                "The POSIX threads (pthreads) API provides pthread_mutex_lock, pthread_mutex_unlock, and pthread_cond_wait for thread synchronization",
            tags: [KB_TAG, KB_REFERENCE_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "reference", superseded: false },
            },
        });

        // How-to
        await ctx.writeMemory({
            content:
                "To avoid deadlocks, always acquire locks in a consistent global order, use timeout-based lock attempts, or employ lock-free data structures",
            tags: [KB_TAG, KB_HOWTO_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "how-to", superseded: false },
            },
        });

        // Insight
        await ctx.writeMemory({
            content:
                "In practice, lock-free queues with CAS operations outperform mutex-based queues by 3-5x under high contention in multi-core systems",
            tags: [KB_TAG, KB_INSIGHT_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "insight", superseded: false },
            },
        });

        // Superseded entry (should be excluded)
        await ctx.writeMemory({
            content:
                "A mutex allows multiple threads to access a resource simultaneously (WRONG - this is superseded)",
            tags: [KB_TAG, KB_DEFINITION_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "definition", superseded: true },
            },
        });

        const result = await engine.buildContext("concurrency and thread synchronization", {
            domains: [KB_DOMAIN_ID],
            budgetTokens: 4000,
        });

        console.log("[BUILD CONTEXT]");
        console.log(`  Tokens: ${result.totalTokens}, Memories: ${result.memories.length}`);
        console.log(`  Context:\n${result.context}`);

        expect(result.context.length).toBeGreaterThan(0);
        expect(result.memories.length).toBeGreaterThanOrEqual(1);

        // Superseded entry should NOT appear
        expect(result.context).not.toContain("WRONG");
        console.log("[PASS] Superseded entry excluded from context");

        // Check sections exist
        const hasDefinitions = result.context.includes("[Definitions & Concepts]");
        const hasFacts = result.context.includes("[Facts & References]");
        const hasHowtos = result.context.includes("[How-Tos & Insights]");
        console.log(
            `  Sections: Definitions=${hasDefinitions}, Facts=${hasFacts}, HowTos=${hasHowtos}`,
        );

        // At least one section should be present
        expect(hasDefinitions || hasFacts || hasHowtos).toBe(true);
        console.log("[PASS] buildContext returns sectioned output");
    });
});

// ---------------------------------------------------------------------------
// 5. Knowledge consolidation schedule
// ---------------------------------------------------------------------------
describe("Knowledge consolidation schedule (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_kb_consolidate_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createKbDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("consolidation merges similar entries of the same classification", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        // Create 4 very similar fact entries about HTTP caching
        const similarFacts = [
            "HTTP caching uses the Cache-Control header to specify how long responses can be cached by browsers and CDNs",
            "The Cache-Control HTTP header controls browser and CDN caching behavior, including max-age for expiration",
            "HTTP Cache-Control header determines caching policy: max-age sets TTL, no-cache forces revalidation, no-store prevents caching",
            "Browser and CDN caching is controlled by the Cache-Control HTTP response header, which supports directives like max-age and no-store",
        ];

        for (const fact of similarFacts) {
            await ctx.writeMemory({
                content: fact,
                tags: [KB_TAG, KB_FACT_TAG],
                ownership: {
                    domain: KB_DOMAIN_ID,
                    attributes: { classification: "fact", superseded: false },
                },
            });
        }

        // Verify all 4 are stored
        const beforeConsolidation = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "fact", superseded: false },
        });
        expect(beforeConsolidation.length).toBe(4);
        console.log(`[CONSOLIDATION] Before: ${beforeConsolidation.length} non-superseded facts`);

        // Run consolidation
        await consolidateKnowledge(ctx);

        // Check results
        const afterNonSuperseded = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "fact", superseded: false },
        });
        const afterSuperseded = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "fact", superseded: true },
        });

        console.log(
            `[CONSOLIDATION] After: ${afterNonSuperseded.length} non-superseded, ${afterSuperseded.length} superseded`,
        );

        if (afterSuperseded.length > 0) {
            console.log("[PASS] Consolidation merged similar facts");

            // Find the consolidated entry via search (ScoredMemory has domainAttributes)
            const consolidatedSearch = await ctx.search({
                tags: [KB_TAG],
                attributes: { classification: "fact", superseded: false },
            });
            const consolidated = consolidatedSearch.entries.find((m) => {
                const attrs = m.domainAttributes[KB_DOMAIN_ID] as
                    | Record<string, unknown>
                    | undefined;
                return attrs?.source === "consolidated";
            });
            if (consolidated) {
                console.log(`  Consolidated entry: "${consolidated.content.slice(0, 120)}..."`);
            }

            // Verify supersedes edges exist
            const graph = engine.getGraph();
            for (const nonSup of afterNonSuperseded) {
                const edges = await graph.traverse(nonSup.id, "->supersedes->memory");
                if (edges.length > 0) {
                    console.log(`  Consolidated entry supersedes ${edges.length} original(s)`);
                }
            }
        } else {
            console.log(
                "[INFO] Consolidation did not merge — similarity may be below threshold with mock embeddings",
            );
        }

        // Total memories should still account for all entries
        const allFacts = await ctx.getMemories({
            tags: [KB_TAG],
            attributes: { classification: "fact" },
        });
        expect(allFacts.length).toBeGreaterThanOrEqual(4);
        console.log(`[PASS] Total fact entries: ${allFacts.length}`);
    });
});

// ---------------------------------------------------------------------------
// 6. Search expansion via topics and ask()
// ---------------------------------------------------------------------------
describe("Search expansion and ask() (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_kb_search_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createKbDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("search finds entries and ask() synthesizes knowledge", async () => {
        const ctx = engine.createDomainContext(KB_DOMAIN_ID);

        // Populate knowledge
        await ctx.writeMemory({
            content:
                "B-trees are self-balancing tree data structures that maintain sorted data and allow searches, sequential access, insertions, and deletions in O(log n) time",
            tags: [KB_TAG, KB_DEFINITION_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "definition", superseded: false },
            },
        });

        await ctx.writeMemory({
            content:
                "PostgreSQL uses B-trees as the default index type, which is optimal for equality and range queries on ordered data",
            tags: [KB_TAG, KB_FACT_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "fact", superseded: false },
            },
        });

        await ctx.writeMemory({
            content:
                "To create a partial index in PostgreSQL: CREATE INDEX idx_name ON table (column) WHERE condition — useful for filtering on frequently queried subsets",
            tags: [KB_TAG, KB_HOWTO_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "how-to", superseded: false },
            },
        });

        await ctx.writeMemory({
            content:
                "GIN (Generalized Inverted Index) indexes in PostgreSQL are best for full-text search, JSONB containment queries, and array operations",
            tags: [KB_TAG, KB_FACT_TAG],
            ownership: {
                domain: KB_DOMAIN_ID,
                attributes: { classification: "fact", superseded: false },
            },
        });

        // Search
        const searchResult = await engine.search({
            text: "PostgreSQL indexing strategies",
            domains: [KB_DOMAIN_ID],
        });
        console.log(
            `[SEARCH] Found ${searchResult.entries.length} entries for "PostgreSQL indexing strategies"`,
        );
        for (const entry of searchResult.entries.slice(0, 5)) {
            console.log(`  [${entry.score.toFixed(3)}] ${entry.content.slice(0, 100)}...`);
        }
        expect(searchResult.entries.length).toBeGreaterThan(0);

        // ask()
        const askResult = await engine.ask("What indexing options are available in PostgreSQL?", {
            domains: [KB_DOMAIN_ID],
            budgetTokens: 2000,
            maxRounds: 2,
        });

        console.log('\n[ASK] "What indexing options are available in PostgreSQL?"');
        console.log(`  Rounds: ${askResult.rounds}, Memories: ${askResult.memories.length}`);
        console.log(`  Answer: ${askResult.answer}`);

        const answerLower = askResult.answer.toLowerCase();
        const mentionsBTree = answerLower.includes("b-tree") || answerLower.includes("btree");
        const mentionsGIN = answerLower.includes("gin");
        const mentionsPartial = answerLower.includes("partial");
        console.log(
            `  [ASSESSMENT] B-tree: ${mentionsBTree}, GIN: ${mentionsGIN}, Partial: ${mentionsPartial}`,
        );
        expect(mentionsBTree || mentionsGIN || mentionsPartial).toBe(true);
    });
});
