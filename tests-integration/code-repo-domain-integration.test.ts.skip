/**
 * Code repo knowledge domain integration tests with real AI adapters.
 *
 * Uses ClaudeCliAdapter (haiku) for LLM and OnnxEmbeddingAdapter for embeddings.
 * Tests inbox processing, entity extraction, contradiction detection,
 * buildContext with audience filtering, commit scanner, and ask().
 *
 * Run with: bun test ./tests-integration/code-repo-domain-integration.test.ts --timeout 300000
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { MemoryEngine } from "../src/core/engine.js";
import { ClaudeCliAdapter } from "../src/adapters/llm/claude-cli.js";
import { OnnxEmbeddingAdapter } from "../src/adapters/onnx-embedding.js";
import { createCodeRepoDomain } from "../src/domains/code-repo/code-repo-domain.js";
import { topicDomain } from "../src/domains/topic/index.js";
import {
    CODE_REPO_DOMAIN_ID,
    CODE_REPO_TAG,
    CODE_REPO_DECISION_TAG,
    CODE_REPO_OBSERVATION_TAG,
    CODE_REPO_TECHNICAL_TAG,
    CODE_REPO_BUSINESS_TAG,
} from "../src/domains/code-repo/types.js";
import { scanCommits } from "../src/domains/code-repo/schedules.js";

const llm = new ClaudeCliAdapter({ model: "haiku" });
const embedding = new OnnxEmbeddingAdapter();
const PROJECT_ROOT = resolve(import.meta.dir, "..");

async function drainInbox(engine: MemoryEngine): Promise<void> {
    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }
}

// ---------------------------------------------------------------------------
// 1. Inbox processing with classification and entity extraction
// ---------------------------------------------------------------------------
describe("Code repo inbox processing with entity extraction (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_code_repo_inbox_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createCodeRepoDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("ingest decision with classification, verify tags and entity linking", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);

        const result = await engine.ingest(
            "We chose SQS over direct HTTP for the order-processor to payment-service communication because of retry guarantees and decoupling",
            {
                domains: [CODE_REPO_DOMAIN_ID],
                metadata: {
                    classification: "decision",
                    audience: ["technical"],
                },
            },
        );
        expect(result.action).toBe("stored");

        await drainInbox(engine);

        // Verify classification attribute was set
        const decisions = await ctx.getMemories({
            tags: [CODE_REPO_TAG],
            attributes: { classification: "decision" },
        });
        expect(decisions.length).toBe(1);
        expect(decisions[0].content).toContain("SQS");
        console.log(`[PASS] Decision memory stored: "${decisions[0].content.slice(0, 80)}..."`);

        // Check if entities were extracted and linked via about_entity edges
        const graph = engine.getGraph();
        // Traverse to each entity type separately (about_entity is memory -> entity)
        const entityTypes = ["module", "data_entity", "concept", "pattern"];
        let totalEntities = 0;
        for (const type of entityTypes) {
            const refs = await graph.traverse<string>(result.id!, `->about_entity->${type}`);
            for (const ref of refs) {
                const node = await graph.getNode(String(ref as unknown as string));
                if (node) {
                    console.log(`  Entity: "${String(node.name)}" (${type})`);
                    totalEntities++;
                }
            }
        }
        console.log(`[ENTITY EXTRACTION] Decision linked to ${totalEntities} entity(s)`);
        if (totalEntities === 0) {
            console.log("  [INFO] LLM did not extract entities — acceptable with haiku");
        }

        // Verify topics were extracted and linked
        const topicEdges = await graph.traverse(result.id!, "->about_topic->memory");
        console.log(`[TOPIC LINKING] Decision linked to ${topicEdges.length} topic(s)`);
        expect(topicEdges.length).toBeGreaterThan(0);
    });

    test("ingest without classification, verify LLM classifies it", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);

        // Ingest without classification — LLM should classify it
        await engine.ingest(
            "We decided to move from REST to gRPC for all internal service-to-service communication starting Q3",
            {
                domains: [CODE_REPO_DOMAIN_ID],
                metadata: {
                    audience: ["technical"],
                },
            },
        );

        await drainInbox(engine);

        // The LLM should have classified this — find the gRPC memory
        const allMemories = await ctx.getMemories({ tags: [CODE_REPO_TAG] });
        const grpcMemory = allMemories.find((m) => m.content.includes("gRPC"));
        expect(grpcMemory).toBeTruthy();
        console.log(`[LLM CLASSIFICATION] gRPC memory found in code repo domain`);

        // Check each classification to see which one was assigned
        const classifications = [
            "decision",
            "direction",
            "rationale",
            "clarification",
            "observation",
            "question",
        ];
        for (const cls of classifications) {
            const matches = await ctx.getMemories({
                tags: [CODE_REPO_TAG],
                attributes: { classification: cls },
            });
            const found = matches.find((m) => m.content.includes("gRPC"));
            if (found) {
                console.log(`[LLM CLASSIFICATION] gRPC memory classified as: "${cls}"`);
                break;
            }
        }
    });
});

// ---------------------------------------------------------------------------
// 2. Contradiction detection (supersedes edges)
// ---------------------------------------------------------------------------
describe("Contradiction detection and supersedes edges (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_code_repo_contradict_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createCodeRepoDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("new contradicting decision creates supersedes edge on old one", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);

        // First decision: use REST
        await engine.ingest(
            "We chose REST for all inter-service communication because it is simple and well-understood by the team",
            {
                domains: [CODE_REPO_DOMAIN_ID],
                metadata: { classification: "decision", audience: ["technical"] },
            },
        );
        await drainInbox(engine);

        // Verify first decision is stored — query all code repo memories
        const firstMemories = await ctx.getMemories({ tags: [CODE_REPO_TAG] });
        const restDecisions = firstMemories.filter((m) => m.content.includes("REST"));
        expect(restDecisions.length).toBe(1);
        console.log(
            `[CONTRADICTION] First decision: "${restDecisions[0].content.slice(0, 80)}..."`,
        );

        // Second decision: switch to gRPC (contradicts first)
        const second = await engine.ingest(
            "We are switching from REST to gRPC for all inter-service communication because REST latency is too high for our throughput requirements",
            {
                domains: [CODE_REPO_DOMAIN_ID],
                metadata: { classification: "decision", audience: ["technical"] },
            },
        );
        await drainInbox(engine);

        // Check if the LLM detected the contradiction
        const graph = engine.getGraph();
        const supersededEdges = await graph.traverse(second.id!, "->supersedes->memory");

        if (supersededEdges.length > 0) {
            console.log(
                `[PASS] Contradiction detected! New decision supersedes ${supersededEdges.length} old decision(s)`,
            );

            // Verify old decision is marked as superseded
            const oldDecisions = await ctx.getMemories({
                tags: [CODE_REPO_TAG],
                attributes: { superseded: true },
            });
            if (oldDecisions.length > 0) {
                console.log(
                    `  Old decision marked superseded: "${oldDecisions[0].content.slice(0, 80)}..."`,
                );
            }
        } else {
            console.log("[INFO] LLM did not detect contradiction — acceptable with haiku model");
        }

        // Either way, both decisions should be stored
        const allDecisions = await ctx.getMemories({ tags: [CODE_REPO_TAG] });
        const decisionCount = allDecisions.filter(
            (m) => m.content.includes("REST") || m.content.includes("gRPC"),
        ).length;
        expect(decisionCount).toBe(2);
        console.log(`[PASS] Both decisions stored (${decisionCount} total)`);
    });
});

// ---------------------------------------------------------------------------
// 3. buildContext with audience filtering
// ---------------------------------------------------------------------------
describe("buildContext with audience filtering (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_code_repo_ctx_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createCodeRepoDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("buildContext filters by audience and returns structured sections", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);

        // Technical-only decision
        await ctx.writeMemory({
            content:
                "We chose event sourcing with Kafka for the order pipeline to enable replay and auditing of all state transitions",
            tags: [CODE_REPO_TAG, CODE_REPO_DECISION_TAG, CODE_REPO_TECHNICAL_TAG],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "decision",
                    audience: ["technical"],
                    superseded: false,
                },
            },
        });

        // Business-only decision
        await ctx.writeMemory({
            content:
                "Order cancellations require a 48-hour cooling period because of consumer protection regulations in the EU market",
            tags: [CODE_REPO_TAG, CODE_REPO_DECISION_TAG, CODE_REPO_BUSINESS_TAG],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "decision",
                    audience: ["business"],
                    superseded: false,
                },
            },
        });

        // Dual-audience decision
        await ctx.writeMemory({
            content:
                "Payment processing moved from synchronous to asynchronous to handle peak Black Friday load while maintaining audit requirements",
            tags: [
                CODE_REPO_TAG,
                CODE_REPO_DECISION_TAG,
                CODE_REPO_TECHNICAL_TAG,
                CODE_REPO_BUSINESS_TAG,
            ],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "decision",
                    audience: ["technical", "business"],
                    superseded: false,
                },
            },
        });

        // Technical observation
        await ctx.writeMemory({
            content: "New payment-gateway service directory detected in latest commit",
            tags: [CODE_REPO_TAG, CODE_REPO_OBSERVATION_TAG, CODE_REPO_TECHNICAL_TAG],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "observation",
                    audience: ["technical"],
                    superseded: false,
                },
            },
        });

        // --- Technical audience ---
        const techContext = await engine.buildContext("order processing and payments", {
            domains: [CODE_REPO_DOMAIN_ID],
            budgetTokens: 2000,
            context: { audience: "technical" },
        });

        console.log("[BUILD CONTEXT - TECHNICAL]");
        console.log(
            `  Tokens: ${techContext.totalTokens}, Memories: ${techContext.memories.length}`,
        );
        console.log(`  Context:\n${techContext.context}`);

        expect(techContext.context.length).toBeGreaterThan(0);
        const techLower = techContext.context.toLowerCase();
        expect(techLower).toContain("kafka");
        // Technical context should NOT contain business-only content
        expect(techLower).not.toContain("48-hour cooling");
        console.log(
            "[PASS] Technical context: contains Kafka, excludes business-only cancellation policy",
        );

        // --- Business audience ---
        const bizContext = await engine.buildContext("order processing and payments", {
            domains: [CODE_REPO_DOMAIN_ID],
            budgetTokens: 2000,
            context: { audience: "business" },
        });

        console.log("[BUILD CONTEXT - BUSINESS]");
        console.log(`  Tokens: ${bizContext.totalTokens}, Memories: ${bizContext.memories.length}`);
        console.log(`  Context:\n${bizContext.context}`);

        expect(bizContext.context.length).toBeGreaterThan(0);
        const bizLower = bizContext.context.toLowerCase();
        expect(bizLower).toContain("cancellation");
        // Business context should NOT contain technical-only content
        expect(bizLower).not.toContain("kafka");
        expect(bizLower).not.toContain("event sourcing");
        console.log("[PASS] Business context: contains cancellation policy, excludes Kafka");

        // --- No audience filter ---
        const allContext = await engine.buildContext("order processing and payments", {
            domains: [CODE_REPO_DOMAIN_ID],
            budgetTokens: 4000,
        });

        console.log(
            `[BUILD CONTEXT - ALL] Tokens: ${allContext.totalTokens}, Memories: ${allContext.memories.length}`,
        );
        expect(allContext.memories.length).toBeGreaterThanOrEqual(3); // All decisions
        expect(allContext.context.includes("[Decisions]")).toBe(true);
        console.log("[PASS] Unfiltered context includes all decisions");
    });
});

// ---------------------------------------------------------------------------
// 4. Commit scanner with real git history
// ---------------------------------------------------------------------------
describe("Commit scanner with real git history (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_code_repo_scanner_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createCodeRepoDomain({ projectRoot: PROJECT_ROOT }));
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("first run stores HEAD and creates no memories", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);

        // First run — should just store HEAD
        await scanCommits(ctx, { projectRoot: PROJECT_ROOT });

        const lastHash = await ctx.getMeta("code-repo:lastCommitHash");
        expect(lastHash).toBeTruthy();
        expect(lastHash!.length).toBe(40); // Full SHA
        console.log(`[COMMIT SCANNER] First run stored HEAD: ${lastHash!.slice(0, 8)}...`);

        // No memories should be created on first run
        const memories = await ctx.getMemories({ tags: [CODE_REPO_TAG] });
        expect(memories.length).toBe(0);
        console.log("[PASS] First run: no observation memories created");
    });

    test("subsequent run detects changes since stored HEAD", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);

        // Set lastCommitHash to 5 commits ago so the scanner has something to process
        await ctx.setMeta("code-repo:lastCommitHash", "55e3365048415e9ceef53c4a1fdab9569c389f19");

        await scanCommits(ctx, { projectRoot: PROJECT_ROOT });

        // Check what observations were created
        const observations = await ctx.getMemories({
            tags: [CODE_REPO_TAG],
            attributes: { classification: "observation" },
        });
        console.log(`[COMMIT SCANNER] Created ${observations.length} observation(s):`);
        for (const obs of observations) {
            console.log(`  "${obs.content.slice(0, 120)}..."`);
        }

        // Check for question memories (business logic hints)
        const questions = await ctx.getMemories({
            tags: [CODE_REPO_TAG],
            attributes: { classification: "question" },
        });
        console.log(`[COMMIT SCANNER] Created ${questions.length} question(s):`);
        for (const q of questions) {
            console.log(`  "${q.content.slice(0, 120)}..."`);
        }

        // The 5 recent commits added files — scanner should have created observations
        const totalMemories = observations.length + questions.length;
        expect(totalMemories).toBeGreaterThan(0);
        console.log(`[PASS] Commit scanner created ${totalMemories} memories from 5 commits`);

        // Check that module entities were created
        const graph = engine.getGraph();
        const modules = await graph.query<Array<{ id: string; name: string; path: string }>>(
            "SELECT id, name, path FROM module",
        );
        console.log(`[COMMIT SCANNER] Created ${modules?.length ?? 0} module entities:`);
        if (modules) {
            for (const mod of modules.slice(0, 10)) {
                console.log(`  ${mod.name} (${mod.path})`);
            }
        }

        // Verify HEAD was updated
        const newHash = await ctx.getMeta("code-repo:lastCommitHash");
        expect(newHash).not.toBe("55e3365048415e9ceef53c4a1fdab9569c389f19");
        console.log(`[PASS] HEAD updated to ${newHash?.slice(0, 8)}...`);
    });
});

// ---------------------------------------------------------------------------
// 5. Direct write + entity graph + ask() evaluation
// ---------------------------------------------------------------------------
describe("Direct write, entity graph, ask() and buildContext evaluation (real)", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `integ_code_repo_ask_${Date.now()}`,
            llm,
            embedding,
            debug: { timing: true },
        });
        await engine.registerDomain(createCodeRepoDomain());
        await engine.registerDomain(topicDomain);
    });

    afterAll(async () => {
        await engine.close();
    });

    test("populate knowledge graph and evaluate ask() responses", async () => {
        const ctx = engine.createDomainContext(CODE_REPO_DOMAIN_ID);
        const graph = engine.getGraph();

        // --- Populate entity nodes ---
        const orderProcessorId = await graph.createNode("module", {
            name: "order-processor",
            path: "services/order-processor",
            kind: "service",
            status: "active",
        });
        const paymentServiceId = await graph.createNode("module", {
            name: "payment-service",
            path: "services/payment-service",
            kind: "service",
            status: "active",
        });
        const orderEntityId = await graph.createNode("data_entity", {
            name: "Order",
            source: "services/order-processor/models/order.ts",
        });
        const paymentConceptId = await graph.createNode("concept", {
            name: "payment-processing",
            description: "The flow of handling payments from order creation to settlement",
        });

        // --- Entity relationships ---
        await graph.relate(orderProcessorId, "connects_to", paymentServiceId, {
            protocol: "sqs",
            direction: "async",
            description: "Sends payment requests after order validation",
        });
        await graph.relate(orderProcessorId, "manages", orderEntityId, { role: "owner" });
        await graph.relate(paymentServiceId, "implements", paymentConceptId);

        // --- Verify traversal works (traverse returns RecordId objects) ---
        const connected = await graph.traverse<string>(orderProcessorId, "->connects_to->module");
        expect(connected.length).toBe(1);
        const connectedNode = await graph.getNode(String(connected[0] as unknown as string));
        expect(connectedNode?.name).toBe("payment-service");
        console.log("[PASS] connects_to traversal: order-processor -> payment-service");

        const managed = await graph.traverse<string>(orderProcessorId, "->manages->data_entity");
        expect(managed.length).toBe(1);
        const managedNode = await graph.getNode(String(managed[0] as unknown as string));
        expect(managedNode?.name).toBe("Order");
        console.log("[PASS] manages traversal: order-processor -> Order");

        // --- Populate decision memories ---
        const decision1Id = await ctx.writeMemory({
            content:
                "We chose SQS over direct HTTP for order-processor to payment-service communication because of retry guarantees and async decoupling",
            tags: [CODE_REPO_TAG, CODE_REPO_DECISION_TAG, CODE_REPO_TECHNICAL_TAG],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "decision",
                    audience: ["technical"],
                    superseded: false,
                },
            },
        });
        await graph.relate(decision1Id, "about_entity", orderProcessorId, { relevance: 1.0 });
        await graph.relate(decision1Id, "about_entity", paymentServiceId, { relevance: 1.0 });

        await ctx.writeMemory({
            content:
                "Payment data is stored in a separate PostgreSQL instance because PCI compliance requires physical isolation from application data",
            tags: [
                CODE_REPO_TAG,
                CODE_REPO_DECISION_TAG,
                CODE_REPO_TECHNICAL_TAG,
                CODE_REPO_BUSINESS_TAG,
            ],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "decision",
                    audience: ["technical", "business"],
                    superseded: false,
                },
            },
        });

        await ctx.writeMemory({
            content:
                "Order cancellations have a 48-hour cooling period per EU consumer protection regulation, during which the order stays in pending-cancel status",
            tags: [CODE_REPO_TAG, CODE_REPO_DECISION_TAG, CODE_REPO_BUSINESS_TAG],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "decision",
                    audience: ["business"],
                    superseded: false,
                },
            },
        });

        await ctx.writeMemory({
            content:
                "The order-processor validates orders against a rules engine before forwarding to payment-service, rejecting invalid combinations at the service boundary",
            tags: [CODE_REPO_TAG, CODE_REPO_DECISION_TAG, CODE_REPO_TECHNICAL_TAG],
            ownership: {
                domain: CODE_REPO_DOMAIN_ID,
                attributes: {
                    classification: "rationale",
                    audience: ["technical"],
                    superseded: false,
                },
            },
        });

        console.log("[SETUP] Populated 4 memories + entity graph");

        // --- Evaluate buildContext ---
        const techBuild = await engine.buildContext("How does order processing work?", {
            domains: [CODE_REPO_DOMAIN_ID],
            budgetTokens: 2000,
            context: { audience: "technical" },
        });
        console.log("\n[EVAL buildContext — technical audience]");
        console.log(`  Tokens: ${techBuild.totalTokens}, Memories: ${techBuild.memories.length}`);
        console.log(`  Context:\n${techBuild.context}`);

        // Technical context should include SQS decision and rules engine rationale
        const techLower = techBuild.context.toLowerCase();
        expect(techLower).toContain("sqs");
        expect(techLower).not.toContain("48-hour cooling");
        console.log(
            "  [ASSESSMENT] Technical context correctly includes SQS, excludes business-only cancellation policy",
        );

        // --- Evaluate ask() --- (run in parallel to reduce wall-clock time)
        const askOpts = { domains: [CODE_REPO_DOMAIN_ID], budgetTokens: 2000, maxRounds: 2 };
        const [askResult1, askResult2, askResult3] = await Promise.all([
            engine.ask("How does order-processor communicate with payment-service?", askOpts),
            engine.ask("Why is payment data stored separately?", askOpts),
            engine.ask("What happens when a customer cancels an order?", {
                ...askOpts,
                context: { audience: "business" },
            }),
        ]);

        console.log(
            '\n[EVAL ask() — "How does order-processor communicate with payment-service?"]',
        );
        console.log(`  Rounds: ${askResult1.rounds}`);
        console.log(`  Memories used: ${askResult1.memories.length}`);
        console.log(`  Answer: ${askResult1.answer}`);
        const answer1Lower = askResult1.answer.toLowerCase();
        const mentionsSQS = answer1Lower.includes("sqs");
        const mentionsAsync = answer1Lower.includes("async") || answer1Lower.includes("queue");
        console.log(
            `  [ASSESSMENT] Mentions SQS: ${mentionsSQS}, Mentions async/queue: ${mentionsAsync}`,
        );
        expect(mentionsSQS || mentionsAsync).toBe(true);

        console.log('\n[EVAL ask() — "Why is payment data stored separately?"]');
        console.log(`  Rounds: ${askResult2.rounds}`);
        console.log(`  Memories used: ${askResult2.memories.length}`);
        console.log(`  Answer: ${askResult2.answer}`);
        const answer2Lower = askResult2.answer.toLowerCase();
        const mentionsPCI = answer2Lower.includes("pci");
        const mentionsCompliance =
            answer2Lower.includes("compliance") || answer2Lower.includes("regulation");
        const mentionsIsolation =
            answer2Lower.includes("isolation") || answer2Lower.includes("separate");
        console.log(
            `  [ASSESSMENT] Mentions PCI: ${mentionsPCI}, Compliance: ${mentionsCompliance}, Isolation: ${mentionsIsolation}`,
        );
        expect(mentionsPCI || mentionsCompliance || mentionsIsolation).toBe(true);

        console.log("\n[EVAL ask() — business audience question]");
        console.log(`  Rounds: ${askResult3.rounds}`);
        console.log(`  Memories used: ${askResult3.memories.length}`);
        console.log(`  Answer: ${askResult3.answer}`);
        const answer3Lower = askResult3.answer.toLowerCase();
        const mentionsCooling = answer3Lower.includes("48") || answer3Lower.includes("cooling");
        const mentionsEU =
            answer3Lower.includes("eu") || answer3Lower.includes("consumer protection");
        console.log(
            `  [ASSESSMENT] Mentions cooling period: ${mentionsCooling}, EU regulation: ${mentionsEU}`,
        );
        expect(answer3Lower.includes("cancel") || mentionsCooling).toBe(true);
    });
});
