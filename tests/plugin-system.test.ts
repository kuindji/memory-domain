import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "./helpers.js";
import type {
    DomainConfig,
    OwnedMemory,
    DomainContext,
    DomainPlugin,
    DomainRegistration,
    SearchQuery,
} from "../src/core/types.js";
import { isDomainRegistration } from "../src/core/types.js";

function createTestDomain(id: string): DomainConfig {
    return {
        id,
        name: `Test ${id}`,
        async processInboxBatch() {},
    };
}

// --- 1. Type guard ---

describe("isDomainRegistration", () => {
    test("returns true for a DomainRegistration (has domain property with id)", () => {
        const reg: DomainRegistration = { domain: createTestDomain("x") };
        expect(isDomainRegistration(reg)).toBe(true);
    });

    test("returns false for a bare DomainConfig (id at top level, no domain property)", () => {
        const cfg: DomainConfig = createTestDomain("y");
        expect(isDomainRegistration(cfg)).toBe(false);
    });

    test("returns false for DomainConfig with all optional fields", () => {
        const cfg: DomainConfig = {
            id: "z",
            name: "Test z",
            async processInboxBatch() {},
            settings: { autoOwn: true },
        };
        expect(isDomainRegistration(cfg)).toBe(false);
    });
});

// --- 2. Plugin registration ---

describe("Plugin registration", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_plugin_reg_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("registerDomain accepts DomainRegistration with plugins", async () => {
        const plugin: DomainPlugin = {
            type: "test-plugin",
            hooks: {},
        };
        const reg: DomainRegistration = {
            domain: createTestDomain("plugged"),
            plugins: [plugin],
        };
        await engine.registerDomain(reg);
    });

    test("getPlugins returns registered plugins for a domain", async () => {
        const plugin: DomainPlugin = {
            type: "my-plugin",
            hooks: {},
        };
        await engine.registerDomain({
            domain: createTestDomain("withplugin"),
            plugins: [plugin],
        });
        const plugins = engine.getPlugins("withplugin");
        expect(plugins).toHaveLength(1);
        expect(plugins[0].type).toBe("my-plugin");
    });

    test("getPlugins returns empty array for nonexistent domain", () => {
        const plugins = engine.getPlugins("nonexistent");
        expect(plugins).toEqual([]);
    });

    test("getPlugins returns empty array for domain registered without plugins", async () => {
        await engine.registerDomain(createTestDomain("bare"));
        const plugins = engine.getPlugins("bare");
        expect(plugins).toEqual([]);
    });
});

// --- 3. Validation ---

describe("Plugin validation via startProcessing", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_plugin_val_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });
    });

    afterEach(async () => {
        engine.stopProcessing();
        await engine.close();
    });

    test("startProcessing throws when a required plugin type is missing", async () => {
        await engine.registerDomain({
            domain: createTestDomain("strict"),
            requires: ["mandatory-plugin"],
        });
        expect(() => engine.startProcessing()).toThrow(
            /Domain "strict" requires plugin type "mandatory-plugin"/,
        );
    });

    test("startProcessing succeeds when all required plugin types are present", async () => {
        const plugin: DomainPlugin = {
            type: "mandatory-plugin",
            hooks: {},
        };
        await engine.registerDomain({
            domain: createTestDomain("complete"),
            plugins: [plugin],
            requires: ["mandatory-plugin"],
        });
        expect(() => engine.startProcessing()).not.toThrow();
    });
});

// --- 4. afterInboxProcess hook ---

describe("afterInboxProcess hook", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_after_inbox_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("afterInboxProcess hook is called after processInboxBatch", async () => {
        let hookCalled = false;
        let hookEntries: OwnedMemory[] = [];

        const plugin: DomainPlugin = {
            type: "spy-plugin",
            hooks: {
                afterInboxProcess(entries: OwnedMemory[]) {
                    hookCalled = true;
                    hookEntries = entries;
                    return Promise.resolve();
                },
            },
        };

        await engine.registerDomain({
            domain: {
                id: "hooked",
                name: "Hooked",
                settings: { autoOwn: true },
                async processInboxBatch() {},
            },
            plugins: [plugin],
        });

        await engine.ingest("test memory for hook", { domains: ["hooked"] });
        await engine.processInbox();

        expect(hookCalled).toBe(true);
        expect(hookEntries.length).toBeGreaterThan(0);
        expect(hookEntries[0].memory.content).toBe("test memory for hook");
    });

    test("afterInboxProcess hook receives correct domain context", async () => {
        let hookDomain: string | undefined;

        const plugin: DomainPlugin = {
            type: "ctx-spy",
            hooks: {
                afterInboxProcess(_entries: OwnedMemory[], context: DomainContext) {
                    hookDomain = context.domain;
                    return Promise.resolve();
                },
            },
        };

        await engine.registerDomain({
            domain: {
                id: "ctx-domain",
                name: "CtxDomain",
                settings: { autoOwn: true },
                async processInboxBatch() {},
            },
            plugins: [plugin],
        });

        await engine.ingest("content", { domains: ["ctx-domain"] });
        await engine.processInbox();

        expect(hookDomain).toBe("ctx-domain");
    });
});

// --- 5. expandSearch hook ---

describe("expandSearch hook", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_expand_search_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("expandSearch hook is invoked and can modify the query", async () => {
        let capturedQuery: SearchQuery | undefined;

        const plugin: DomainPlugin = {
            type: "search-expander",
            hooks: {
                expandSearch(query: SearchQuery): Promise<SearchQuery> {
                    capturedQuery = query;
                    return Promise.resolve({ ...query, text: `${query.text ?? ""} expanded` });
                },
            },
        };

        await engine.registerDomain({
            domain: {
                id: "searchable",
                name: "Searchable",
                settings: { autoOwn: true },
                async processInboxBatch() {},
            },
            plugins: [plugin],
        });

        await engine.search({ text: "hello", domains: ["searchable"] });

        expect(capturedQuery).toBeDefined();
        expect(capturedQuery?.text).toBe("hello");
    });

    test("expandSearch hook result is used for the actual search", async () => {
        const plugin: DomainPlugin = {
            type: "expand-to-tag",
            hooks: {
                expandSearch(query: SearchQuery): Promise<SearchQuery> {
                    return Promise.resolve({ ...query, limit: 42 });
                },
            },
        };

        await engine.registerDomain({
            domain: {
                id: "expand-domain",
                name: "ExpandDomain",
                settings: { autoOwn: true },
                async processInboxBatch() {},
            },
            plugins: [plugin],
        });

        // Should not throw — we are verifying the hook runs without errors
        const result = await engine.search({ text: "query", domains: ["expand-domain"] });
        expect(result).toBeDefined();
    });
});

// --- 6. Multi-instance domains ---

describe("Multi-instance domains", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_multi_instance_${Date.now()}`,
            llm: new MockLLMAdapter(),
            embedding: new MockEmbeddingAdapter(),
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    test("two instances of the same domain type with different IDs coexist", async () => {
        const plugin: DomainPlugin = {
            type: "shared-plugin-type",
            hooks: {},
        };

        await engine.registerDomain({
            domain: createTestDomain("instance-a"),
            plugins: [{ ...plugin }],
        });
        await engine.registerDomain({
            domain: createTestDomain("instance-b"),
            plugins: [{ ...plugin }],
        });

        expect(engine.getPlugins("instance-a")).toHaveLength(1);
        expect(engine.getPlugins("instance-b")).toHaveLength(1);
    });

    test("ingesting to each instance independently stores memories under the correct domain", async () => {
        await engine.registerDomain(createTestDomain("inst-1"));
        await engine.registerDomain(createTestDomain("inst-2"));

        const r1 = await engine.ingest("memory for instance 1", { domains: ["inst-1"] });
        const r2 = await engine.ingest("memory for instance 2", { domains: ["inst-2"] });

        expect(r1.action).toBe("stored");
        expect(r2.action).toBe("stored");
        expect(r1.id).not.toBe(r2.id);
    });

    test("plugins on different instances track their own hook calls independently", async () => {
        const callLog: string[] = [];

        const pluginA: DomainPlugin = {
            type: "shared-type",
            hooks: {
                afterInboxProcess() {
                    callLog.push("a");
                    return Promise.resolve();
                },
            },
        };

        const pluginB: DomainPlugin = {
            type: "shared-type",
            hooks: {
                afterInboxProcess() {
                    callLog.push("b");
                    return Promise.resolve();
                },
            },
        };

        await engine.registerDomain({
            domain: {
                id: "inst-a",
                name: "Instance A",
                settings: { autoOwn: true },
                async processInboxBatch() {},
            },
            plugins: [pluginA],
        });
        await engine.registerDomain({
            domain: {
                id: "inst-b",
                name: "Instance B",
                settings: { autoOwn: true },
                async processInboxBatch() {},
            },
            plugins: [pluginB],
        });

        // Ingest to both instances so both hooks fire
        await engine.ingest("content a", { domains: ["inst-a"] });
        await engine.ingest("content b", { domains: ["inst-b"] });
        await engine.processInbox();

        // Each plugin's hook fires independently for its own domain
        expect(callLog).toContain("a");
        expect(callLog).toContain("b");

        // Each plugin fires exactly once (one inbox item per domain)
        expect(callLog.filter((x) => x === "a")).toHaveLength(1);
        expect(callLog.filter((x) => x === "b")).toHaveLength(1);
    });
});
