import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InboxProcessor } from "../src/core/inbox-processor.js";
import { GraphStore } from "../src/core/graph-store.js";
import { SchemaRegistry } from "../src/core/schema-registry.js";
import { DomainRegistry } from "../src/core/domain-registry.js";
import { EventEmitter } from "../src/core/events.js";
import { createTestDb, MockLLMAdapter } from "./helpers.js";
import type { Surreal } from "surrealdb";
import type { DomainConfig, OwnedMemory, DomainContext } from "../src/core/types.js";

describe("InboxProcessor", () => {
    let db: Surreal;
    let store: GraphStore;
    let domainRegistry: DomainRegistry;
    let events: EventEmitter;
    let processor: InboxProcessor;
    const processedItems: OwnedMemory[] = [];
    const claimCalls: string[] = [];

    beforeEach(async () => {
        processedItems.length = 0;
        claimCalls.length = 0;
        db = await createTestDb();
        const schema = new SchemaRegistry(db);
        await schema.registerCore();
        store = new GraphStore(db);
        domainRegistry = new DomainRegistry();
        events = new EventEmitter();
        processor = new InboxProcessor(
            store,
            domainRegistry,
            events,
            (domainId: string, requestContext?: Record<string, unknown>) =>
                ({
                    domain: domainId,
                    graph: store,
                    llm: new MockLLMAdapter(),
                    requestContext: requestContext ?? {},
                }) as unknown as DomainContext,
        );
    });

    afterEach(async () => {
        await db.close();
    });

    // Helper to create a memory with inbox tag
    async function createInboxMemory(
        content: string,
        embedding?: number[],
        requestContext?: Record<string, unknown>,
    ): Promise<string> {
        const data: Record<string, unknown> = {
            content,
            created_at: Date.now(),
            token_count: content.split(" ").length,
        };
        if (embedding) {
            data.embedding = embedding;
        }
        if (requestContext) {
            data.request_context = requestContext;
        }
        const memId = await store.createNode("memory", data);
        try {
            await store.createNodeWithId("tag:inbox", { label: "inbox", created_at: Date.now() });
        } catch {
            /* already exists */
        }
        await store.relate(memId, "tagged", "tag:inbox");
        return memId;
    }

    // Helper to add an inbox:domain processing tag
    async function addInboxDomainTag(memId: string, domainId: string): Promise<void> {
        const tagId = `tag:\`inbox:${domainId}\``;
        try {
            await store.createNodeWithId(tagId, {
                label: `inbox:${domainId}`,
                created_at: Date.now(),
            });
        } catch {
            /* already exists */
        }
        await store.relate(memId, "tagged", tagId);
    }

    // Helper to add an assert-claim tag
    async function addAssertClaimTag(memId: string, domainId: string): Promise<void> {
        const tagId = `tag:\`inbox:assert-claim:${domainId}\``;
        try {
            await store.createNodeWithId(tagId, {
                label: `inbox:assert-claim:${domainId}`,
                created_at: Date.now(),
            });
        } catch {
            /* already exists */
        }
        await store.relate(memId, "tagged", tagId);
    }

    // Helper to create domain node
    async function createDomainNode(domainId: string): Promise<void> {
        try {
            await store.createNodeWithId(`domain:${domainId}`, { name: domainId });
        } catch {
            /* already exists */
        }
    }

    describe("Phase 1: Claim Assertion", () => {
        test("assertInboxClaimBatch is called for domains with assert-claim tags", async () => {
            const domain: DomainConfig = {
                id: "claimer",
                name: "Claimer",
                async processInboxBatch() {},
                assertInboxClaimBatch(entries) {
                    for (const e of entries) claimCalls.push(e.memory.content);
                    return Promise.resolve(entries.map((e) => e.memory.id));
                },
            };
            domainRegistry.register(domain);

            const memId = await createInboxMemory("claim me");
            await addAssertClaimTag(memId, "claimer");

            await processor.tick();

            expect(claimCalls).toEqual(["claim me"]);
        });

        test("domain claiming creates owned_by edge and triggers processing", async () => {
            const domain: DomainConfig = {
                id: "claimer",
                name: "Claimer",
                processInboxBatch(entries: OwnedMemory[]): Promise<void> {
                    processedItems.push(...entries);
                    return Promise.resolve();
                },
                assertInboxClaimBatch(entries) {
                    return Promise.resolve(entries.map((e) => e.memory.id));
                },
            };
            domainRegistry.register(domain);
            await createDomainNode("claimer");

            const memId = await createInboxMemory("claim me");
            await addAssertClaimTag(memId, "claimer");

            await processor.tick();

            // Check owned_by edge exists
            const owners = await store.query<{ out: unknown }[]>(
                "SELECT out FROM owned_by WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            expect(owners?.length).toBe(1);

            // Phase 2 should have processed it in the same tick
            expect(processedItems.length).toBe(1);
            expect(processedItems[0].memory.content).toBe("claim me");
        });

        test("domain declining removes assert-claim tag only", async () => {
            const domain: DomainConfig = {
                id: "decliner",
                name: "Decliner",
                async processInboxBatch() {},
                assertInboxClaimBatch() {
                    return Promise.resolve([]);
                },
            };
            domainRegistry.register(domain);

            // Also register an autoOwn domain so memory isn't orphaned
            const autoOwn: DomainConfig = {
                id: "auto",
                name: "Auto",
                settings: { autoOwn: true },
                async processInboxBatch() {},
            };
            domainRegistry.register(autoOwn);
            await createDomainNode("auto");

            const memId = await createInboxMemory("not for decliner");
            await addAssertClaimTag(memId, "decliner");
            // Give auto domain ownership
            await store.relate(memId, "owned_by", "domain:auto", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "auto");

            await processor.tick();

            // Assert-claim tag should be removed
            const assertTags = await store.query<string[]>(
                `SELECT VALUE out.label FROM tagged WHERE in = $memId AND string::starts_with(out.label, 'inbox:assert-claim:')`,
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            expect(assertTags?.length ?? 0).toBe(0);

            // No owned_by edge for decliner
            const owners = await store.query<{ out: unknown }[]>(
                `SELECT out FROM owned_by WHERE in = $memId AND out = domain:decliner`,
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            expect(owners?.length ?? 0).toBe(0);
        });

        test("unclaimed memory with no owners gets deleted", async () => {
            const domain: DomainConfig = {
                id: "decliner",
                name: "Decliner",
                async processInboxBatch() {},
                assertInboxClaimBatch() {
                    return Promise.resolve([]);
                },
            };
            domainRegistry.register(domain);

            const memId = await createInboxMemory("nobody wants me");
            await addAssertClaimTag(memId, "decliner");

            await processor.tick();

            const memory = await store.getNode(memId);
            expect(memory).toBeNull();
        });

        test("multiple domains assert in parallel", async () => {
            const calls: string[] = [];
            const domainA: DomainConfig = {
                id: "a",
                name: "A",
                async processInboxBatch() {},
                assertInboxClaimBatch(entries) {
                    calls.push("a");
                    return Promise.resolve(entries.map((e) => e.memory.id));
                },
            };
            const domainB: DomainConfig = {
                id: "b",
                name: "B",
                async processInboxBatch() {},
                assertInboxClaimBatch() {
                    calls.push("b");
                    return Promise.resolve([]);
                },
            };
            domainRegistry.register(domainA);
            domainRegistry.register(domainB);
            await createDomainNode("a");

            const memId = await createInboxMemory("shared content");
            await addAssertClaimTag(memId, "a");
            await addAssertClaimTag(memId, "b");

            await processor.tick();

            expect(calls).toContain("a");
            expect(calls).toContain("b");
        });

        test("assertInboxClaimBatch error does not block other domains", async () => {
            const errorEvents: unknown[] = [];
            events.on("error", (...args: unknown[]) => {
                errorEvents.push(args[0]);
            });

            const domainA: DomainConfig = {
                id: "thrower",
                name: "Thrower",
                async processInboxBatch() {},
                assertInboxClaimBatch() {
                    throw new Error("boom");
                },
            };
            const domainB: DomainConfig = {
                id: "claimer",
                name: "Claimer",
                async processInboxBatch() {},
                assertInboxClaimBatch(entries) {
                    return Promise.resolve(entries.map((e) => e.memory.id));
                },
            };
            domainRegistry.register(domainA);
            domainRegistry.register(domainB);
            await createDomainNode("claimer");

            const memId = await createInboxMemory("test content");
            await addAssertClaimTag(memId, "thrower");
            await addAssertClaimTag(memId, "claimer");

            await processor.tick();

            // Claimer should still have claimed
            const owners = await store.query<{ out: unknown }[]>(
                "SELECT out FROM owned_by WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            expect(owners?.length).toBe(1);
            expect(errorEvents.length).toBe(1);

            const tags = await store.query<string[]>(
                "SELECT VALUE out.label FROM tagged WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            expect(tags).toContain("inbox:failed-assert-claim:thrower");
            expect(tags).not.toContain("inbox");
        });

        test("transient assertInboxClaimBatch errors are retried before quarantine", async () => {
            const domain: DomainConfig = {
                id: "flaky",
                name: "Flaky",
                async processInboxBatch() {},
                assertInboxClaimBatch() {
                    throw new Error("LLM timeout while classifying");
                },
            };
            domainRegistry.register(domain);

            const memId = await createInboxMemory("retry me");
            await addAssertClaimTag(memId, "flaky");

            const firstTick = await processor.tick();
            const afterFirst = await store.query<string[]>(
                "SELECT VALUE out.label FROM tagged WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );

            const secondTick = await processor.tick();
            const afterSecond = await store.query<string[]>(
                "SELECT VALUE out.label FROM tagged WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );

            expect(firstTick).toBe(true);
            expect(secondTick).toBe(true);
            expect(afterFirst).toContain("inbox");
            expect(afterFirst).toContain("inbox:assert-claim:flaky");
            expect(afterFirst).not.toContain("inbox:failed-assert-claim:flaky");
            expect(afterSecond).not.toContain("inbox");
            expect(afterSecond).not.toContain("inbox:assert-claim:flaky");
            expect(afterSecond).toContain("inbox:failed-assert-claim:flaky");
        });

        test("quarantined assert-claim failures keep unowned memories for review", async () => {
            const domain: DomainConfig = {
                id: "broken",
                name: "Broken",
                async processInboxBatch() {},
                assertInboxClaimBatch() {
                    throw new Error("bug in claim logic");
                },
            };
            domainRegistry.register(domain);

            const memId = await createInboxMemory("do not delete me");
            await addAssertClaimTag(memId, "broken");

            await processor.tick();

            const memory = await store.getNode(memId);
            expect(memory).not.toBeNull();

            const tags = await store.query<string[]>(
                "SELECT VALUE out.label FROM tagged WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            expect(tags).toContain("inbox:failed-assert-claim:broken");
            expect(tags).not.toContain("inbox");
        });
    });

    describe("Phase 2: Inbox Processing", () => {
        test("processInboxBatch called for domain with inbox:domain tag", async () => {
            const domain: DomainConfig = {
                id: "test",
                name: "Test",
                processInboxBatch(entries: OwnedMemory[]): Promise<void> {
                    processedItems.push(...entries);
                    return Promise.resolve();
                },
            };
            domainRegistry.register(domain);
            await createDomainNode("test");

            const memId = await createInboxMemory("process me");
            await store.relate(memId, "owned_by", "domain:test", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "test");

            await processor.tick();

            expect(processedItems.length).toBe(1);
            expect(processedItems[0].memory.content).toBe("process me");
        });

        test("inbox tag removed when all domain tags cleared", async () => {
            const domainA: DomainConfig = {
                id: "a",
                name: "A",
                async processInboxBatch() {},
            };
            const domainB: DomainConfig = {
                id: "b",
                name: "B",
                async processInboxBatch() {},
            };
            domainRegistry.register(domainA);
            domainRegistry.register(domainB);
            await createDomainNode("a");
            await createDomainNode("b");

            const memId = await createInboxMemory("multi-domain");
            await store.relate(memId, "owned_by", "domain:a", {
                attributes: {},
                owned_at: Date.now(),
            });
            await store.relate(memId, "owned_by", "domain:b", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "a");
            await addInboxDomainTag(memId, "b");

            await processor.tick();

            // inbox tag should be removed
            const tags = await store.query<string[]>(
                `SELECT VALUE out.label FROM tagged WHERE in = $memId`,
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            const inboxTags = (tags ?? []).filter(
                (l) => typeof l === "string" && l.startsWith("inbox"),
            );
            expect(inboxTags.length).toBe(0);
        });

        test("error in one domain does not block others", async () => {
            const errorEvents: unknown[] = [];
            events.on("error", (...args: unknown[]) => {
                errorEvents.push(args[0]);
            });

            const domainA: DomainConfig = {
                id: "thrower",
                name: "Thrower",
                processInboxBatch(): Promise<void> {
                    throw new Error("boom");
                },
            };
            const domainB: DomainConfig = {
                id: "worker",
                name: "Worker",
                processInboxBatch(entries: OwnedMemory[]): Promise<void> {
                    processedItems.push(...entries);
                    return Promise.resolve();
                },
            };
            domainRegistry.register(domainA);
            domainRegistry.register(domainB);
            await createDomainNode("thrower");
            await createDomainNode("worker");

            const memId = await createInboxMemory("mixed results");
            await store.relate(memId, "owned_by", "domain:thrower", {
                attributes: {},
                owned_at: Date.now(),
            });
            await store.relate(memId, "owned_by", "domain:worker", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "thrower");
            await addInboxDomainTag(memId, "worker");

            await processor.tick();

            expect(processedItems.length).toBe(1);
            expect(errorEvents.length).toBe(1);

            const tags = await store.query<string[]>(
                "SELECT VALUE out.label FROM tagged WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );
            expect(tags).toContain("inbox:failed:thrower");
            expect(tags).not.toContain("inbox:worker");
            expect(tags).not.toContain("inbox");
        });

        test("transient processInboxBatch errors are retried before quarantine", async () => {
            const errorEvents: unknown[] = [];
            events.on("error", (...args: unknown[]) => {
                errorEvents.push(args[0]);
            });

            const domain: DomainConfig = {
                id: "flaky",
                name: "Flaky",
                processInboxBatch(): Promise<void> {
                    throw new Error("temporary network timeout");
                },
            };
            domainRegistry.register(domain);
            await createDomainNode("flaky");

            const memId = await createInboxMemory("retry processing");
            await store.relate(memId, "owned_by", "domain:flaky", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "flaky");

            const firstTick = await processor.tick();
            const afterFirst = await store.query<string[]>(
                "SELECT VALUE out.label FROM tagged WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );

            const secondTick = await processor.tick();
            const afterSecond = await store.query<string[]>(
                "SELECT VALUE out.label FROM tagged WHERE in = $memId",
                { memId: new (await import("surrealdb")).StringRecordId(memId) },
            );

            expect(firstTick).toBe(false);
            expect(secondTick).toBe(false);
            expect(errorEvents).toHaveLength(2);
            expect(afterFirst).toContain("inbox");
            expect(afterFirst).toContain("inbox:flaky");
            expect(afterFirst).not.toContain("inbox:failed:flaky");
            expect(afterSecond).not.toContain("inbox");
            expect(afterSecond).not.toContain("inbox:flaky");
            expect(afterSecond).toContain("inbox:failed:flaky");
        });

        test("batches inbox processing by request context", async () => {
            const seenContexts: Array<{
                contents: string[];
                requestContext: Record<string, unknown>;
            }> = [];

            const domain: DomainConfig = {
                id: "chat-like",
                name: "ChatLike",
                processInboxBatch(entries: OwnedMemory[], context: DomainContext): Promise<void> {
                    seenContexts.push({
                        contents: entries.map((entry) => entry.memory.content),
                        requestContext: context.requestContext,
                    });
                    return Promise.resolve();
                },
            };
            domainRegistry.register(domain);
            await createDomainNode("chat-like");

            const first = await createInboxMemory("message one", undefined, {
                userId: "user-1",
                chatSessionId: "session-1",
            });
            await store.relate(first, "owned_by", "domain:chat-like", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(first, "chat-like");

            const second = await createInboxMemory("message two", undefined, {
                userId: "user-2",
                chatSessionId: "session-2",
            });
            await store.relate(second, "owned_by", "domain:chat-like", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(second, "chat-like");

            const firstTick = await processor.tick();
            const secondTick = await processor.tick();

            expect(firstTick).toBe(true);
            expect(secondTick).toBe(true);
            expect(seenContexts).toHaveLength(2);
            expect(seenContexts).toEqual([
                {
                    contents: ["message one"],
                    requestContext: { userId: "user-1", chatSessionId: "session-1" },
                },
                {
                    contents: ["message two"],
                    requestContext: { userId: "user-2", chatSessionId: "session-2" },
                },
            ]);
        });
    });

    describe("Lock", () => {
        test("stale lock is overridden", async () => {
            await store.createNodeWithId("meta:_inbox_lock", {
                value: JSON.stringify({ lockedAt: Date.now() - 3_600_000 }),
            });

            const domain: DomainConfig = {
                id: "test",
                name: "Test",
                processInboxBatch(entries: OwnedMemory[]): Promise<void> {
                    processedItems.push(...entries);
                    return Promise.resolve();
                },
            };
            domainRegistry.register(domain);
            await createDomainNode("test");

            const memId = await createInboxMemory("stale lock test");
            await store.relate(memId, "owned_by", "domain:test", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "test");

            await processor.tick();

            expect(processedItems.length).toBe(1);
            const lock = await store.getNode("meta:_inbox_lock");
            expect(lock).toBeNull();
        });

        test("fresh lock prevents processing", async () => {
            await store.createNodeWithId("meta:_inbox_lock", {
                value: JSON.stringify({ lockedAt: Date.now() }),
            });

            const domain: DomainConfig = {
                id: "test",
                name: "Test",
                processInboxBatch(entries: OwnedMemory[]): Promise<void> {
                    processedItems.push(...entries);
                    return Promise.resolve();
                },
            };
            domainRegistry.register(domain);
            await createDomainNode("test");

            const memId = await createInboxMemory("locked test");
            await store.relate(memId, "owned_by", "domain:test", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "test");

            await processor.tick();

            expect(processedItems.length).toBe(0);
        });

        test("lock is released after processing", async () => {
            const domain: DomainConfig = {
                id: "test",
                name: "Test",
                processInboxBatch(entries: OwnedMemory[]): Promise<void> {
                    processedItems.push(...entries);
                    return Promise.resolve();
                },
            };
            domainRegistry.register(domain);
            await createDomainNode("test");

            const memId = await createInboxMemory("lock release test");
            await store.relate(memId, "owned_by", "domain:test", {
                attributes: {},
                owned_at: Date.now(),
            });
            await addInboxDomainTag(memId, "test");

            await processor.tick();

            const lock = await store.getNode("meta:_inbox_lock");
            expect(lock).toBeNull();
            expect(processedItems.length).toBe(1);
        });
    });
});
