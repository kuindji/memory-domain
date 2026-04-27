import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter } from "./helpers.js";
import { createTopicDomain } from "../src/domains/topic/index.js";
import type {
    WriteOptions,
    WriteResult,
    UpdateOptions,
    ScheduleInfo,
    TraversalNode,
} from "../src/core/types.js";

// --- Type-level compile checks (Task 1) ---

function checkWriteOptions(o: WriteOptions): void {
    const _domain: string = o.domain;
    const _tags: string[] | undefined = o.tags;
    const _attrs: Record<string, unknown> | undefined = o.attributes;
    void _domain;
    void _tags;
    void _attrs;
}

function checkWriteResult(r: WriteResult): void {
    const _id: string = r.id;
    void _id;
}

function checkUpdateOptions(o: UpdateOptions): void {
    const _text: string | undefined = o.text;
    const _attrs: Record<string, unknown> | undefined = o.attributes;
    void _text;
    void _attrs;
}

function checkScheduleInfo(s: ScheduleInfo): void {
    const _id: string = s.id;
    const _domain: string = s.domain;
    const _name: string = s.name;
    const _interval: number = s.interval;
    const _lastRun: number | undefined = s.lastRun;
    void _id;
    void _domain;
    void _name;
    void _interval;
    void _lastRun;
}

function checkTraversalNode(n: TraversalNode): void {
    const _id: string = n.id;
    const _depth: number = n.depth;
    const _edge: string = n.edge;
    const _dir: "in" | "out" = n.direction;
    void _id;
    void _depth;
    void _edge;
    void _dir;
}

// Exercise type checks so they are not tree-shaken
it("types compile correctly", () => {
    const wo: WriteOptions = { domain: "test", tags: ["a"], attributes: { k: 1 } };
    const wr: WriteResult = { id: "memory:abc" };
    const uo: UpdateOptions = { text: "hi", attributes: { x: 2 } };
    const si: ScheduleInfo = { id: "sched:1", domain: "d", name: "n", interval: 60000 };
    const tn: TraversalNode = { id: "memory:1", depth: 1, edge: "reinforces", direction: "out" };
    checkWriteOptions(wo);
    checkWriteResult(wr);
    checkUpdateOptions(uo);
    checkScheduleInfo(si);
    checkTraversalNode(tn);
    expect(wo.domain).toBe("test");
    expect(wr.id).toBe("memory:abc");
    expect(uo.text).toBe("hi");
    expect(si.interval).toBe(60000);
    expect(tn.direction).toBe("out");
});

// --- writeMemory tests (Task 2) ---

describe("MemoryEngine.writeMemory", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_write_${Date.now()}`,
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

    it("creates memory with domain ownership", async () => {
        const result = await engine.writeMemory("hello world", { domain: "test" });
        expect(result.id).toBeTruthy();
        expect(result.id).toMatch(/^memory:/);

        const owners = await engine
            .getGraph()
            .query<
                { out: string }[]
            >("SELECT out FROM owned_by WHERE in = $id", { id: new StringRecordId(result.id) });
        const ownerIds = (owners ?? []).map((o) => String(o.out));
        expect(ownerIds).toContain("domain:test");
    });

    it("assigns tags when provided", async () => {
        const result = await engine.writeMemory("tagged content", {
            domain: "log",
            tags: ["work", "important"],
        });

        const tagged = await engine
            .getGraph()
            .query<
                { out: string }[]
            >("SELECT out FROM tagged WHERE in = $id", { id: new StringRecordId(result.id) });
        const tagIds = (tagged ?? []).map((o) => String(o.out));
        expect(tagIds).toContain("tag:work");
        expect(tagIds).toContain("tag:important");
    });

    it("sets domain attributes when provided", async () => {
        const result = await engine.writeMemory("attributed content", {
            domain: "test",
            attributes: { source: "test", priority: 1 },
        });

        const edges = await engine
            .getGraph()
            .query<
                { attributes: Record<string, unknown> }[]
            >("SELECT attributes FROM owned_by WHERE in = $id AND out = domain:test", { id: new StringRecordId(result.id) });
        expect(edges).toBeTruthy();
        expect(edges?.[0].attributes.source).toBe("test");
        expect(edges?.[0].attributes.priority).toBe(1);
    });

    it("does not tag with inbox", async () => {
        const result = await engine.writeMemory("direct memory", { domain: "test" });

        const tagged = await engine
            .getGraph()
            .query<
                { out: string }[]
            >("SELECT out FROM tagged WHERE in = $id", { id: new StringRecordId(result.id) });
        const tagIds = (tagged ?? []).map((o) => String(o.out));
        expect(tagIds).not.toContain("tag:inbox");
    });
});

// --- getMemory / updateMemory / deleteMemory tests (Task 3) ---

describe("MemoryEngine CRUD methods", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_crud_${Date.now()}`,
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

    it("reads an existing memory", async () => {
        const { id } = await engine.writeMemory("readable content", { domain: "test" });
        const entry = await engine.getMemory(id);
        expect(entry).not.toBeNull();
        expect(entry!.id).toBe(id);
        expect(entry!.content).toBe("readable content");
        expect(typeof entry!.createdAt).toBe("number");
        expect(typeof entry!.tokenCount).toBe("number");
    });

    it("returns null for non-existent memory", async () => {
        const entry = await engine.getMemory("memory:nonexistent123");
        expect(entry).toBeNull();
    });

    it("updates text of existing memory", async () => {
        const { id } = await engine.writeMemory("original text", { domain: "test" });
        await engine.updateMemory(id, { text: "updated text" });
        const entry = await engine.getMemory(id);
        expect(entry!.content).toBe("updated text");
    });

    it("update recalculates token count", async () => {
        const { id } = await engine.writeMemory("short", { domain: "test" });
        const before = await engine.getMemory(id);
        await engine.updateMemory(id, {
            text: "a much longer piece of text with many more tokens than before",
        });
        const after = await engine.getMemory(id);
        expect(after!.tokenCount).toBeGreaterThan(before!.tokenCount);
    });

    it("deletes a memory", async () => {
        const { id } = await engine.writeMemory("to be deleted", { domain: "test" });
        await engine.deleteMemory(id);
        const entry = await engine.getMemory(id);
        expect(entry).toBeNull();
    });

    it("throws when updating non-existent memory", () => {
        expect(engine.updateMemory("memory:nonexistent456", { text: "new text" })).rejects.toThrow(
            "Memory not found",
        );
    });

    it("throws when deleting non-existent memory", () => {
        expect(engine.deleteMemory("memory:nonexistent789")).rejects.toThrow("Memory not found");
    });
});

// --- tagMemory / untagMemory / getMemoryTags tests (Task 4) ---

describe("MemoryEngine tagging methods", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_tags_${Date.now()}`,
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

    it("adds a tag to a memory", async () => {
        const { id } = await engine.writeMemory("tagme", { domain: "test" });
        await engine.tagMemory(id, "mytag");
        const tags = await engine.getMemoryTags(id);
        expect(tags).toContain("mytag");
    });

    it("removes a tag from a memory", async () => {
        const { id } = await engine.writeMemory("tagme2", { domain: "test" });
        await engine.tagMemory(id, "removeme");
        await engine.untagMemory(id, "removeme");
        const tags = await engine.getMemoryTags(id);
        expect(tags).not.toContain("removeme");
    });

    it("lists multiple tags", async () => {
        const { id } = await engine.writeMemory("multi-tagged", { domain: "test" });
        await engine.tagMemory(id, "alpha");
        await engine.tagMemory(id, "beta");
        await engine.tagMemory(id, "gamma");
        const tags = await engine.getMemoryTags(id);
        expect(tags).toContain("alpha");
        expect(tags).toContain("beta");
        expect(tags).toContain("gamma");
    });

    it("returns empty array for non-existent memory", async () => {
        const tags = await engine.getMemoryTags("memory:doesnotexist");
        expect(tags).toEqual([]);
    });
});

// --- graph methods tests (Task 5) ---

describe("MemoryEngine graph methods", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_graph_${Date.now()}`,
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

    it("relate creates an edge between two memories", async () => {
        const { id: id1 } = await engine.writeMemory("first memory", { domain: "test" });
        const { id: id2 } = await engine.writeMemory("second memory", { domain: "test" });

        const edgeId = await engine.relate(id1, id2, "reinforces", "test");
        expect(edgeId).toBeTruthy();
        expect(edgeId).toMatch(/^reinforces:/);
    });

    it("relate creates an edge with attributes", async () => {
        const { id: id1 } = await engine.writeMemory("source", { domain: "test" });
        const { id: id2 } = await engine.writeMemory("target", { domain: "test" });

        await engine.relate(id1, id2, "reinforces", "test", { strength: 0.9 });

        const edges = await engine.getEdges(id1, "out");
        const reinforcesEdges = edges.filter((e) => String(e.id).startsWith("reinforces:"));
        expect(reinforcesEdges.length).toBeGreaterThan(0);
        const edge = reinforcesEdges.find((e) => String(e.out) === id2);
        expect(edge).toBeDefined();
        expect(edge!.strength).toBe(0.9);
    });

    it("getEdges returns edges for a node", async () => {
        const { id: id1 } = await engine.writeMemory("base memory", { domain: "test" });
        const { id: id2 } = await engine.writeMemory("related memory", { domain: "test" });

        await engine.relate(id1, id2, "reinforces", "test");

        const edges = await engine.getEdges(id1);
        // Should have at least the reinforces edge and owned_by edge
        expect(edges.length).toBeGreaterThan(0);
        const edgeIds = edges.map((e) => String(e.id));
        expect(edgeIds.some((id) => id.startsWith("reinforces:"))).toBe(true);
    });

    it("getEdges respects direction filter out", async () => {
        const { id: id1 } = await engine.writeMemory("outgoing memory", { domain: "test" });
        const { id: id2 } = await engine.writeMemory("incoming memory", { domain: "test" });

        await engine.relate(id1, id2, "reinforces", "test");

        const outEdges = await engine.getEdges(id2, "out");
        // id2 is target of the reinforces edge, so querying 'out' (outgoing) from id2 should not include it
        const reinforcesFromId2 = outEdges.filter(
            (e) => String(e.id).startsWith("reinforces:") && String(e.in) === id2,
        );
        expect(reinforcesFromId2.length).toBe(0);

        const inEdges = await engine.getEdges(id2, "in");
        // id2 is target (out side of edge), so querying 'in' (incoming to id2) should include it
        const reinforcesToId2 = inEdges.filter(
            (e) => String(e.id).startsWith("reinforces:") && String(e.out) === id2,
        );
        expect(reinforcesToId2.length).toBe(1);
    });

    it("unrelate removes an edge", async () => {
        const { id: id1 } = await engine.writeMemory("source to unrelate", { domain: "test" });
        const { id: id2 } = await engine.writeMemory("target to unrelate", { domain: "test" });

        await engine.relate(id1, id2, "reinforces", "test");

        // Confirm edge exists
        const before = await engine.getEdges(id1, "out");
        expect(
            before.some((e) => String(e.id).startsWith("reinforces:") && String(e.out) === id2),
        ).toBe(true);

        await engine.unrelate(id1, id2, "reinforces");

        const after = await engine.getEdges(id1, "out");
        expect(
            after.some((e) => String(e.id).startsWith("reinforces:") && String(e.out) === id2),
        ).toBe(false);
    });

    it("traverse follows edges BFS", async () => {
        const { id: id1 } = await engine.writeMemory("root node", { domain: "test" });
        const { id: id2 } = await engine.writeMemory("level 1 node", { domain: "test" });
        const { id: id3 } = await engine.writeMemory("level 2 node", { domain: "test" });

        await engine.relate(id1, id2, "reinforces", "test");
        await engine.relate(id2, id3, "reinforces", "test");

        const depth1 = await engine.traverse(id1, ["reinforces"], 1);
        expect(depth1.length).toBe(1);
        expect(depth1[0].id).toBe(id2);
        expect(depth1[0].depth).toBe(1);
        expect(depth1[0].edge).toBe("reinforces");
        expect(depth1[0].direction).toBe("out");

        const depth2 = await engine.traverse(id1, ["reinforces"], 2);
        expect(depth2.length).toBe(2);
        const ids = depth2.map((n) => n.id);
        expect(ids).toContain(id2);
        expect(ids).toContain(id3);
        expect(depth2.find((n) => n.id === id3)!.depth).toBe(2);
    });
});

// --- schedule methods tests (Task 6) ---

describe("MemoryEngine schedule methods", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_schedules_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(createTopicDomain());
    });

    afterEach(async () => {
        await engine.close();
    });

    it("listSchedules returns all registered schedules", () => {
        const schedules = engine.listSchedules();
        expect(schedules.length).toBeGreaterThan(0);
        expect(schedules.every((s) => s.id && s.domain && s.name && s.interval > 0)).toBe(true);
    });

    it("listSchedules filters by domain", () => {
        const topicSchedules = engine.listSchedules("topic");
        expect(topicSchedules.length).toBeGreaterThan(0);
        expect(topicSchedules.every((s) => s.domain === "topic")).toBe(true);
    });

    it("listSchedules returns empty array for unknown domain", () => {
        const schedules = engine.listSchedules("nonexistent-domain");
        expect(schedules).toEqual([]);
    });

    it("triggerSchedule runs a schedule", async () => {
        const schedules = engine.listSchedules("topic");
        expect(schedules.length).toBeGreaterThan(0);
        const schedule = schedules[0];
        // Should not throw
        await engine.triggerSchedule("topic", schedule.id);
    });

    it("triggerSchedule throws for unknown schedule", () => {
        expect(engine.triggerSchedule("topic", "nonexistent-schedule")).rejects.toThrow(
            "Schedule not found",
        );
    });

    it("triggerSchedule throws for unknown domain", () => {
        expect(engine.triggerSchedule("unknown-domain", "some-schedule")).rejects.toThrow(
            "Schedule not found",
        );
    });
});
