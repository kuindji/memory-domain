import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";
import { consolidateUserProfile } from "../src/domains/user/schedules.js";
import {
    USER_TAG,
    USER_DOMAIN_ID,
    DEFAULT_CONSOLIDATE_INTERVAL_MS,
} from "../src/domains/user/types.js";
import { createUserDomain, userDomain } from "../src/domains/user/index.js";
import type { DomainConfig, OwnedMemory, DomainContext } from "../src/core/types.js";

describe("User domain - config", () => {
    test("has correct id and name", () => {
        const domain = createUserDomain();
        expect(domain.id).toBe("user");
        expect(domain.name).toBe("User");
    });

    test("has baseDir and 3 skills", () => {
        const domain = createUserDomain();
        expect(domain.baseDir).toBeTypeOf("string");
        expect(domain.baseDir!.length).toBeGreaterThan(0);
        expect(domain.skills).toHaveLength(3);
        const skillIds = domain.skills!.map((s) => s.id);
        expect(skillIds).toContain("user-data");
        expect(skillIds).toContain("user-query");
        expect(skillIds).toContain("user-profile");
    });

    test("schema declares user node (with userId unique index), memory classification field, about_user and supersedes edges", () => {
        const domain = createUserDomain();
        const nodes = domain.schema!.nodes;
        const userNode = nodes.find((n) => n.name === "user");
        expect(userNode).toBeDefined();
        expect(userNode!.fields).toEqual([{ name: "userId", type: "string", required: true }]);
        expect(userNode!.indexes).toHaveLength(1);
        expect(userNode!.indexes![0].type).toBe("unique");

        const memoryNode = nodes.find((n) => n.name === "memory");
        expect(memoryNode).toBeDefined();
        expect(memoryNode!.fields.some((f) => f.name === "classification")).toBe(true);

        const edges = domain.schema!.edges;
        const aboutUser = edges.find((e) => e.name === "about_user");
        expect(aboutUser).toBeDefined();
        expect(aboutUser!.from).toBe("memory");
        expect(aboutUser!.to).toBe("user");

        const supersedes = edges.find((e) => e.name === "supersedes");
        expect(supersedes).toBeDefined();
        expect(supersedes!.from).toBe("memory");
        expect(supersedes!.to).toBe("memory");
    });

    test("default options include consolidation schedule", () => {
        const domain = createUserDomain();
        expect(domain.schedules).toHaveLength(1);
        expect(domain.schedules![0].id).toBe("consolidate-user-profile");
        expect(domain.schedules![0].intervalMs).toBe(DEFAULT_CONSOLIDATE_INTERVAL_MS);
    });

    test("consolidation schedule can be disabled", () => {
        const domain = createUserDomain({ consolidateSchedule: { enabled: false } });
        expect(domain.schedules).toHaveLength(0);
    });

    test("consolidation schedule accepts custom interval", () => {
        const domain = createUserDomain({ consolidateSchedule: { intervalMs: 5000 } });
        expect(domain.schedules).toHaveLength(1);
        expect(domain.schedules![0].intervalMs).toBe(5000);
    });

    test("processInboxBatch is defined (user domain now processes facts)", () => {
        const domain = createUserDomain();
        expect(typeof domain.processInboxBatch).toBe("function");
    });

    test("describe() returns a non-empty string", () => {
        const domain = createUserDomain();
        const describeFn = domain.describe?.bind(domain);
        expect(describeFn).toBeTypeOf("function");
        const description = describeFn!();
        expect(description).toBeTypeOf("string");
        expect(description.length).toBeGreaterThan(0);
    });

    test("default userDomain instance is valid", () => {
        expect(userDomain.id).toBe(USER_DOMAIN_ID);
        expect(userDomain.schedules).toHaveLength(1);
    });
});

describe("User domain - integration", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user" },
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(userDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    test("user node can be created and retrieved", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        await ctx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        const node = await ctx.graph.getNode("user:test-user");
        expect(node).toBeDefined();
        expect(node!.userId).toBe("test-user");
    });

    test("user fact can be stored and linked to user node via about_user edge", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        await ctx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        const memId = await ctx.writeMemory({
            content: "User is proficient in TypeScript and Rust",
            tags: [`${USER_TAG}/expertise`],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });

        await ctx.graph.relate(memId, "about_user", "user:test-user", { domain: USER_DOMAIN_ID });

        const edges = await ctx.getNodeEdges("user:test-user", "in");
        expect(edges.length).toBeGreaterThan(0);
        const sourceIds = edges.map((e) => String(e.in));
        expect(
            sourceIds.some((id) => id === memId || id === `memory:${memId}` || memId.endsWith(id)),
        ).toBe(true);
    });

    test("user fact tags are retrievable via getMemoryTags", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);

        // Ensure tag node exists so getMemoryTags can resolve the label
        const tagLabel = `${USER_TAG}/preference`;
        try {
            await ctx.graph.createNodeWithId(`tag:${tagLabel}`, {
                label: tagLabel,
                created_at: Date.now(),
            });
        } catch {
            /* already exists */
        }

        const memId = await ctx.writeMemory({
            content: "User prefers dark mode",
            tags: [`${USER_TAG}/preference`],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });

        // Process inbox so tags are clean (inbox tag removed)
        await engine.processInbox();

        const tags = await ctx.getMemoryTags(memId);
        expect(tags).toContain(`${USER_TAG}/preference`);
    });

    test("another domain can link its memory to user via about_user edge", async () => {
        const notesDomain: DomainConfig = {
            id: "notes",
            name: "Notes",
            schema: { nodes: [], edges: [] },
            async processInboxBatch(_entries: OwnedMemory[], _context: DomainContext) {},
        };
        await engine.registerDomain(notesDomain);

        // Create context after registering notes so it's in visible domains
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        await ctx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        const ingestResult = await engine.ingest("User mentioned they enjoy hiking on weekends", {
            domains: ["notes"],
        });
        expect(ingestResult.action).toBe("stored");
        const memId = ingestResult.id!;

        await ctx.graph.relate(memId, "about_user", "user:test-user", { domain: "notes" });

        const edges = await ctx.getNodeEdges("user:test-user", "in");
        expect(edges.length).toBeGreaterThan(0);
        const sourceIds = edges.map((e) => String(e.in));
        expect(
            sourceIds.some((id) => id === memId || id === `memory:${memId}` || memId.endsWith(id)),
        ).toBe(true);
    });

    test("search.expand hook receives userId from request context", () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        expect(ctx.requestContext.userId).toBe("test-user");
    });
});

describe("User domain - inbox processing (kb-style attributes and supersession)", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        // Used for question-generation fallback path (no extractStructured on MockLLMAdapter)
        llm.generateResult = "What is the user's preference?";
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_user_inbox_${Date.now()}`,
            context: { userId: "user-A" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(userDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    test("processInboxBatch populates classification, validFrom, importance, answersQuestion", async () => {
        await engine.ingest("User prefers concise responses without bullet lists", {
            domains: [USER_DOMAIN_ID],
            metadata: { classification: "preference", userId: "user-A" },
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        const memories = await ctx.getMemories({ tags: [USER_TAG] });
        expect(memories.length).toBeGreaterThanOrEqual(1);

        const target = memories.find((m) => m.content.includes("concise"));
        expect(target).toBeDefined();

        const attrRows = await engine
            .getGraph()
            .query<
                Array<{ attributes: Record<string, unknown> }>
            >("SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId LIMIT 1", {
                memId: new StringRecordId(target!.id),
                domainId: new StringRecordId(`domain:${USER_DOMAIN_ID}`),
            });
        const attrs = attrRows?.[0]?.attributes;
        expect(attrs).toBeDefined();
        expect(attrs.classification).toBe("preference");
        expect(attrs.superseded).toBe(false);
        expect(typeof attrs.validFrom).toBe("number");
        expect(attrs.confidence).toBe(1.0);
        expect(typeof attrs.importance).toBe("number");
        expect(attrs.userId).toBe("user-A");
        expect(attrs.answersQuestion).toBeTypeOf("string");
        expect((attrs.answersQuestion as string).length).toBeGreaterThan(0);
    });

    test("processInboxBatch creates about_user edge when userId is provided", async () => {
        await engine.ingest("User is based in Berlin", {
            domains: [USER_DOMAIN_ID],
            metadata: { classification: "identity", userId: "user-A" },
        });
        await engine.processInbox();

        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        const edges = await ctx.getNodeEdges("user:user-A", "in");
        const sourceIds = edges.map((e) => String(e.in));
        expect(sourceIds.length).toBeGreaterThanOrEqual(1);
    });
});

describe("User domain - consolidation schedule", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        llm.consolidateResult = "Test user is a TypeScript developer who enjoys hiking.";
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(userDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    test("consolidation creates a profile summary from linked memories", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        await ctx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        // Use 'fact' tag (not user/* subtag) to avoid SurrealDB record ID collision
        // with the profile-summary tag during getMemories filtering
        const mem1 = await ctx.writeMemory({
            content: "User is proficient in TypeScript",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await ctx.graph.relate(mem1, "about_user", "user:test-user", { domain: USER_DOMAIN_ID });

        const mem2 = await ctx.writeMemory({
            content: "User enjoys hiking on weekends",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await ctx.graph.relate(mem2, "about_user", "user:test-user", { domain: USER_DOMAIN_ID });

        await consolidateUserProfile(ctx);

        // Verify a summary was created by checking all domain memories for the consolidated content
        const allMemories = await ctx.getMemories({ domains: [USER_DOMAIN_ID] });
        const summaryMemory = allMemories.find((m) => m.content === llm.consolidateResult);
        expect(summaryMemory).toBeDefined();

        // Verify the summary is linked to the user node via about_user edge
        const edges = await ctx.getNodeEdges("user:test-user", "in");
        const summaryEdge = edges.find((e) => String(e.in) === summaryMemory!.id);
        expect(summaryEdge).toBeDefined();
    });

    test("consolidation skips when no user nodes exist", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);

        await consolidateUserProfile(ctx);

        const allMemories = await ctx.getMemories({ domains: [USER_DOMAIN_ID] });
        expect(allMemories.length).toBe(0);
    });

    test("consolidation skips superseded memories", async () => {
        // Replace the engine's LLM with a spy-enabled mock so we can inspect
        // the contents passed to consolidate().
        const spyLlm = new (class extends MockLLMAdapter {
            calls: string[][] = [];
            consolidate(memories?: string[]): Promise<string> {
                this.calls.push(memories ?? []);
                return Promise.resolve(this.consolidateResult);
            }
        })();
        spyLlm.consolidateResult = "Test user prefers tea.";
        const spyEngine = new MemoryEngine();
        await spyEngine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_user_cons_skip_${Date.now()}`,
            context: { userId: "test-user" },
            llm: spyLlm,
            embedding: new MockEmbeddingAdapter(),
        });
        await spyEngine.registerDomain(userDomain);

        const ctx = spyEngine.createDomainContext(USER_DOMAIN_ID);
        await ctx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        // Live fact
        const live = await ctx.writeMemory({
            content: "User prefers tea",
            tags: ["fact"],
            ownership: {
                domain: USER_DOMAIN_ID,
                attributes: { classification: "preference", superseded: false },
            },
        });
        await ctx.graph.relate(live, "about_user", "user:test-user", { domain: USER_DOMAIN_ID });

        // Superseded fact (should be skipped)
        const stale = await ctx.writeMemory({
            content: "User prefers coffee",
            tags: ["fact"],
            ownership: {
                domain: USER_DOMAIN_ID,
                attributes: {
                    classification: "preference",
                    superseded: true,
                    validUntil: Date.now() - 1000,
                },
            },
        });
        await ctx.graph.relate(stale, "about_user", "user:test-user", { domain: USER_DOMAIN_ID });

        await consolidateUserProfile(ctx);

        expect(spyLlm.calls.length).toBeGreaterThanOrEqual(1);
        const consolidated = spyLlm.calls[0];
        expect(consolidated.some((c) => c.includes("tea"))).toBe(true);
        expect(consolidated.some((c) => c.includes("coffee"))).toBe(false);

        await spyEngine.close();
    });

    test("consolidation updates existing summary instead of creating duplicate", async () => {
        const ctx = engine.createDomainContext(USER_DOMAIN_ID);
        await ctx.graph.createNodeWithId("user:test-user", { userId: "test-user" });

        const mem1 = await ctx.writeMemory({
            content: "User likes TypeScript",
            tags: ["fact"],
            ownership: { domain: USER_DOMAIN_ID, attributes: {} },
        });
        await ctx.graph.relate(mem1, "about_user", "user:test-user", { domain: USER_DOMAIN_ID });

        // First consolidation
        await consolidateUserProfile(ctx);

        // Verify a summary was created
        const afterFirst = await ctx.getMemories({ domains: [USER_DOMAIN_ID] });
        const firstSummary = afterFirst.find((m) => m.content === llm.consolidateResult);
        expect(firstSummary).toBeDefined();

        // Change the LLM result for second run
        llm.consolidateResult = "Updated: User is a senior TypeScript developer.";

        // Second consolidation
        await consolidateUserProfile(ctx);

        // Verify that the summary was updated, not duplicated
        const afterSecond = await ctx.getMemories({ domains: [USER_DOMAIN_ID] });
        const summaries = afterSecond.filter((m) => m.id !== mem1);
        expect(summaries.length).toBe(1);
        expect(summaries[0].content).toBe("Updated: User is a senior TypeScript developer.");
    });
});
