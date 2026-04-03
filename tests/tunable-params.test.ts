import { describe, test, expect, beforeEach } from "bun:test";
import { TunableParamRegistry } from "../src/core/tunable-params.js";
import type { TunableParamDefinition } from "../src/core/tunable-params.js";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter } from "./helpers.js";

const sampleParams: TunableParamDefinition[] = [
    { name: "threshold", default: 0.5, min: 0, max: 1, step: 0.1 },
    { name: "maxResults", default: 10, min: 1, max: 100, step: 1 },
];

describe("TunableParamRegistry", () => {
    let registry: TunableParamRegistry;

    beforeEach(() => {
        registry = new TunableParamRegistry();
    });

    test("registers params and returns defaults", () => {
        registry.register("test-domain", sampleParams);
        expect(registry.get("test-domain", "threshold")).toBe(0.5);
        expect(registry.get("test-domain", "maxResults")).toBe(10);
    });

    test("applies overrides from persisted values", () => {
        registry.register("test-domain", sampleParams);
        registry.applyOverrides("test-domain", { threshold: 0.8, maxResults: 50 });
        expect(registry.get("test-domain", "threshold")).toBe(0.8);
        expect(registry.get("test-domain", "maxResults")).toBe(50);
    });

    test("clamps overrides to min/max range", () => {
        registry.register("test-domain", sampleParams);
        registry.applyOverrides("test-domain", { threshold: 5, maxResults: -10 });
        expect(registry.get("test-domain", "threshold")).toBe(1);
        expect(registry.get("test-domain", "maxResults")).toBe(1);
    });

    test("getAllForDomain returns all current values", () => {
        registry.register("test-domain", sampleParams);
        registry.applyOverrides("test-domain", { threshold: 0.7 });
        const all = registry.getAllForDomain("test-domain");
        expect(all).toEqual({ threshold: 0.7, maxResults: 10 });
    });

    test("getDefinitions returns param definitions for a domain", () => {
        registry.register("test-domain", sampleParams);
        const defs = registry.getDefinitions("test-domain");
        expect(defs).toEqual(sampleParams);
    });

    test("get returns undefined for unknown domain or param", () => {
        registry.register("test-domain", sampleParams);
        expect(registry.get("unknown-domain", "threshold")).toBeUndefined();
        expect(registry.get("test-domain", "nonexistent")).toBeUndefined();
    });

    test("getDomainIds returns registered domains", () => {
        registry.register("domain-a", sampleParams);
        registry.register("domain-b", sampleParams);
        expect(registry.getDomainIds()).toEqual(["domain-a", "domain-b"]);
    });

    test("applyOverrides silently skips unknown params", () => {
        registry.register("test-domain", sampleParams);
        registry.applyOverrides("test-domain", { nonexistent: 42 });
        expect(registry.get("test-domain", "threshold")).toBe(0.5);
        expect(registry.get("test-domain", "maxResults")).toBe(10);
    });

    test("applyOverrides is no-op for unknown domain", () => {
        registry.applyOverrides("unknown", { threshold: 0.9 });
        expect(registry.getDomainIds()).toEqual([]);
    });

    test("getAllForDomain returns empty object for unknown domain", () => {
        expect(registry.getAllForDomain("unknown")).toEqual({});
    });

    test("getDefinitions returns empty array for unknown domain", () => {
        expect(registry.getDefinitions("unknown")).toEqual([]);
    });
});

describe("Engine tunable param integration", () => {
    test("registers domain tunableParams and exposes via context", async () => {
        const engine = new MemoryEngine();
        const llm = new MockLLMAdapter();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_tune_${Date.now()}`,
            llm,
        });

        let capturedMinScore: number | undefined;
        await engine.registerDomain({
            id: "tuned",
            name: "Tuned",
            tunableParams: [{ name: "minScore", default: 0.3, min: 0.1, max: 0.9, step: 0.05 }],
            processInboxBatch(_entries, context) {
                capturedMinScore = context.getTunableParam("minScore");
                return Promise.resolve();
            },
        });

        await engine.ingest("test", { domains: ["tuned"] });
        await engine.processInbox();

        expect(capturedMinScore).toBe(0.3);
        await engine.close();
    });

    test("saveTunableParams persists and updates values", async () => {
        const engine = new MemoryEngine();
        const llm = new MockLLMAdapter();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_tune_persist_${Date.now()}`,
            llm,
        });

        await engine.registerDomain({
            id: "tuned",
            name: "Tuned",
            tunableParams: [{ name: "minScore", default: 0.3, min: 0.1, max: 0.9, step: 0.05 }],
            async processInboxBatch() {},
        });

        await engine.saveTunableParams("tuned", { minScore: 0.55 });
        const params = engine.getTunableParams("tuned");
        expect(params.minScore).toBe(0.55);
        await engine.close();
    });

    test("getTunableParamDefinitions returns definitions", async () => {
        const engine = new MemoryEngine();
        const llm = new MockLLMAdapter();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_tune_defs_${Date.now()}`,
            llm,
        });

        await engine.registerDomain({
            id: "tuned",
            name: "Tuned",
            tunableParams: [{ name: "weight", default: 0.5, min: 0.0, max: 1.0, step: 0.1 }],
            async processInboxBatch() {},
        });

        const defs = engine.getTunableParamDefinitions("tuned");
        expect(defs).toHaveLength(1);
        expect(defs[0].name).toBe("weight");
        await engine.close();
    });
});
