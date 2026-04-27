import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter } from "./helpers.js";
import type { DomainConfig, OwnedMemory, DomainContext } from "../src/core/types.js";

describe("Domain visibility", () => {
    let engine: MemoryEngine;

    const domainA: DomainConfig = {
        id: "domaina",
        name: "Domain A",
        settings: { includeDomains: ["domainb"] },
        async processInboxBatch(_entries: OwnedMemory[], _ctx: DomainContext) {},
    };

    const domainB: DomainConfig = {
        id: "domainb",
        name: "Domain B",
        async processInboxBatch(_entries: OwnedMemory[], _ctx: DomainContext) {},
    };

    const domainC: DomainConfig = {
        id: "domainc",
        name: "Domain C",
        settings: { excludeDomains: ["domaina"] },
        async processInboxBatch(_entries: OwnedMemory[], _ctx: DomainContext) {},
    };

    const domainD: DomainConfig = {
        id: "domaind",
        name: "Domain D",
        async processInboxBatch(_entries: OwnedMemory[], _ctx: DomainContext) {},
    };

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(domainA);
        await engine.registerDomain(domainB);
        await engine.registerDomain(domainC);
        await engine.registerDomain(domainD);

        // Ingest data owned by each domain
        await engine.ingest("content from A", { domains: ["domaina"] });
        await engine.ingest("content from B", { domains: ["domainb"] });
        await engine.ingest("content from C", { domains: ["domainc"] });
        await engine.ingest("content from D", { domains: ["domaind"] });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("getVisibleDomains with includeDomains returns only listed domains plus self", () => {
        const ctx = engine.createDomainContext("domaina");
        const visible = ctx.getVisibleDomains();
        expect(visible.sort()).toEqual(["domaina", "domainb"]);
    });

    test("getVisibleDomains with excludeDomains returns all except excluded plus self", () => {
        const ctx = engine.createDomainContext("domainc");
        const visible = ctx.getVisibleDomains();
        expect(visible).toContain("domainc");
        expect(visible).toContain("domainb");
        expect(visible).toContain("domaind");
        expect(visible).not.toContain("domaina");
    });

    test("getVisibleDomains with no settings returns all domains", () => {
        const ctx = engine.createDomainContext("domainb");
        const visible = ctx.getVisibleDomains();
        expect(visible).toContain("domaina");
        expect(visible).toContain("domainb");
        expect(visible).toContain("domainc");
        expect(visible).toContain("domaind");
    });

    test("search from domain with includeDomains only finds visible data", async () => {
        // domaina can only see domainb (and itself)
        const ctx = engine.createDomainContext("domaina");
        const result = await ctx.search({ mode: "fulltext", text: "content" });
        const contents = result.entries.map((e) => e.content);
        expect(contents).toContain("content from A");
        expect(contents).toContain("content from B");
        expect(contents).not.toContain("content from C");
        expect(contents).not.toContain("content from D");
    });

    test("search from domain with excludeDomains hides excluded data", async () => {
        // domainc excludes domaina
        const ctx = engine.createDomainContext("domainc");
        const result = await ctx.search({ mode: "fulltext", text: "content" });
        const contents = result.entries.map((e) => e.content);
        expect(contents).toContain("content from C");
        expect(contents).toContain("content from B");
        expect(contents).toContain("content from D");
        expect(contents).not.toContain("content from A");
    });

    test("search from domain with no settings sees all data", async () => {
        const ctx = engine.createDomainContext("domaind");
        const result = await ctx.search({ mode: "fulltext", text: "content" });
        expect(result.entries.length).toBeGreaterThanOrEqual(4);
    });

    test("getMemories from domain with includeDomains respects visibility", async () => {
        const ctx = engine.createDomainContext("domaina");
        const memories = await ctx.getMemories();
        const contents = memories.map((m) => m.content);
        expect(contents).toContain("content from A");
        expect(contents).toContain("content from B");
        expect(contents).not.toContain("content from C");
        expect(contents).not.toContain("content from D");
    });

    test("getMemory returns null for memory owned only by non-visible domain", async () => {
        const ctx = engine.createDomainContext("domaina");
        // domaina can only see domaina + domainb
        // Find a memory owned by domainc
        const ctxC = engine.createDomainContext("domainc");
        const memoriesC = await ctxC.getMemories({ domains: ["domainc"] });
        const memoryFromC = memoriesC.find((m) => m.content === "content from C");
        expect(memoryFromC).toBeDefined();

        const result = await ctx.getMemory(memoryFromC!.id);
        expect(result).toBeNull();
    });

    test("getMemory returns memory owned by visible domain", async () => {
        const ctx = engine.createDomainContext("domaina");
        // domaina can see domainb
        const ctxB = engine.createDomainContext("domainb");
        const memoriesB = await ctxB.getMemories({ domains: ["domainb"] });
        const memoryFromB = memoriesB.find((m) => m.content === "content from B");
        expect(memoryFromB).toBeDefined();

        const result = await ctx.getMemory(memoryFromB!.id);
        expect(result).toBeDefined();
        expect(result!.content).toBe("content from B");
    });

    test("getMemoryTags returns empty for memory owned only by non-visible domain", async () => {
        const ctx = engine.createDomainContext("domaina");
        const ctxC = engine.createDomainContext("domainc");
        const memoriesC = await ctxC.getMemories({ domains: ["domainc"] });
        const memoryFromC = memoriesC.find((m) => m.content === "content from C");
        expect(memoryFromC).toBeDefined();

        const tags = await ctx.getMemoryTags(memoryFromC!.id);
        expect(tags).toEqual([]);
    });

    test("getNodeEdges filters edges connecting to memories from non-visible domains", async () => {
        // domaina can only see domaina + domainb
        const ctx = engine.createDomainContext("domaina");

        // Get a memory from domaina
        const memoriesA = await ctx.getMemories({ domains: ["domaina"] });
        const memoryFromA = memoriesA.find((m) => m.content === "content from A");
        expect(memoryFromA).toBeDefined();

        // Get all edges from this memory — owned_by and tagged edges point to non-memory nodes and should pass through
        const edges = await ctx.getNodeEdges(memoryFromA!.id, "out");
        expect(edges.length).toBeGreaterThan(0);
    });

    test("getNodeEdges excludes edges to non-visible memory nodes", async () => {
        // Create a cross-memory reference edge between domainA memory and domainD memory
        const graph = engine.getGraph();
        const ctxD = engine.createDomainContext("domaind");
        const memoriesD = await ctxD.getMemories({ domains: ["domaind"] });
        const memoryFromD = memoriesD.find((m) => m.content === "content from D");

        const ctxA = engine.createDomainContext("domaina");
        const memoriesA = await ctxA.getMemories({ domains: ["domaina"] });
        const memoryFromA = memoriesA.find((m) => m.content === "content from A");

        // Create a reinforces edge from A -> D
        await graph.relate(memoryFromA!.id, "reinforces", memoryFromD!.id, {
            strength: 0.9,
            detected_at: Date.now(),
        });

        // From domaina's context, getNodeEdges should NOT include the edge to memoryFromD
        // because domaina can only see domaina + domainb
        const ctxFiltered = engine.createDomainContext("domaina");
        const edges = await ctxFiltered.getNodeEdges(memoryFromA!.id, "out");

        const reinforcesEdges = edges.filter((e) => String(e.id).startsWith("reinforces:"));
        expect(reinforcesEdges.length).toBe(0);
    });

    test("domain settings stored in DB node", async () => {
        const graph = engine.getGraph();
        const node = await graph.getNode("domain:domaina");
        expect(node).toBeDefined();
        const settings = node!.settings as Record<string, unknown>;
        expect(settings).toBeDefined();
        expect(settings.includeDomains).toEqual(["domainb"]);
    });
});
