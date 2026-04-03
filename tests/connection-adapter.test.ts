import { describe, it, expect } from "bun:test";
import type { ConnectionAdapter, S3AdapterConfig } from "../src/core/types.ts";

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
