import { describe, it, expect } from "bun:test";
import type { ConnectionAdapter, S3AdapterConfig } from "../src/core/types.ts";
import { PassthroughAdapter } from "../src/adapters/connection/passthrough.ts";
import { MemoryEngine } from "../src/core/engine.ts";
import { MockLLMAdapter } from "./helpers.ts";

describe("ConnectionAdapter types", () => {
    it("ConnectionAdapter has resolve and save methods", () => {
        const adapter: ConnectionAdapter = {
            resolve: () => Promise.resolve("mem://"),
            save: () => Promise.resolve(),
        };
        expect(typeof adapter.resolve).toBe("function");
        expect(typeof adapter.save).toBe("function");
    });

    it("S3AdapterConfig has required and optional fields", () => {
        const minimal: S3AdapterConfig = {
            bucket: "test",
            key: "db.tar.gz",
            region: "us-east-1",
        };
        expect(minimal.bucket).toBe("test");

        const full: S3AdapterConfig = {
            bucket: "test",
            key: "db.tar.gz",
            region: "us-east-1",
            localDir: "/tmp/test",
            save: true,
            credentials: {
                accessKeyId: "key",
                secretAccessKey: "secret",
            },
        };
        expect(full.save).toBe(true);
    });

    it("EngineConfig accepts adapter instead of connection", () => {
        const adapter: ConnectionAdapter = {
            resolve: () => Promise.resolve("mem://"),
            save: () => Promise.resolve(),
        };
        const _config = {
            adapter,
            llm: {} as import("../src/core/types.ts").LLMAdapter,
        };
        void _config;
    });
});

describe("PassthroughAdapter", () => {
    it("resolve returns the connection string unchanged", async () => {
        const adapter = new PassthroughAdapter("surrealkv:///path/to/db");
        const result = await adapter.resolve();
        expect(result).toBe("surrealkv:///path/to/db");
    });

    it("save is a no-op", async () => {
        const adapter = new PassthroughAdapter("mem://");
        await adapter.save();
    });

    it("implements ConnectionAdapter", () => {
        const adapter: ConnectionAdapter = new PassthroughAdapter("mem://");
        expect(typeof adapter.resolve).toBe("function");
        expect(typeof adapter.save).toBe("function");
    });
});

describe("Engine adapter integration", () => {
    it("uses PassthroughAdapter when connection string is provided", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_passthrough_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.close();
    });

    it("uses provided adapter instead of connection string", async () => {
        const calls: string[] = [];
        const mockAdapter: ConnectionAdapter = {
            async resolve() {
                calls.push("resolve");
                return "mem://";
            },
            async save() {
                calls.push("save");
            },
        };

        const engine = new MemoryEngine();
        await engine.initialize({
            adapter: mockAdapter,
            namespace: "test",
            database: `test_adapter_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });

        expect(calls).toEqual(["resolve"]);

        await engine.close();
        expect(calls).toEqual(["resolve", "save"]);
    });

    it("throws if neither connection nor adapter is provided", async () => {
        const engine = new MemoryEngine();
        await expect(
            engine.initialize({
                namespace: "test",
                database: "test",
                llm: new MockLLMAdapter(),
            }),
        ).rejects.toThrow();
    });
});
