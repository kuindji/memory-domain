import { describe, it, expect } from "bun:test";
import type { ConnectionAdapter, S3AdapterConfig } from "../src/core/types.js";
import { PassthroughAdapter } from "../src/adapters/connection/passthrough.js";
import { S3ConnectionAdapter } from "../src/adapters/connection/s3.js";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter } from "./helpers.js";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import * as tar from "tar";

describe("ConnectionAdapter types", () => {
    it("ConnectionAdapter has resolve and save methods", () => {
        const adapter: ConnectionAdapter = {
            resolve: () => Promise.resolve({ kind: "pglite" } as const),
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
            resolve: () => Promise.resolve({ kind: "pglite" } as const),
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
    it("resolve returns the DbConfig unchanged", async () => {
        const cfg = { kind: "pglite", dataDir: "/path/to/db" } as const;
        const adapter = new PassthroughAdapter(cfg);
        const result = await adapter.resolve();
        expect(result).toEqual(cfg);
    });

    it("save is a no-op", async () => {
        const adapter = new PassthroughAdapter({ kind: "pglite" });
        await adapter.save();
    });

    it("implements ConnectionAdapter", () => {
        const adapter: ConnectionAdapter = new PassthroughAdapter({ kind: "pglite" });
        expect(typeof adapter.resolve).toBe("function");
        expect(typeof adapter.save).toBe("function");
    });
});

describe("Engine adapter integration", () => {
    it("uses PassthroughAdapter when connection string is provided", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            llm: new MockLLMAdapter(),
        });
        await engine.close();
    });

    it("uses provided adapter instead of connection string", async () => {
        const calls: string[] = [];
        const mockAdapter: ConnectionAdapter = {
            resolve() {
                calls.push("resolve");
                return Promise.resolve({ kind: "pglite" } as const);
            },
            save() {
                calls.push("save");
                return Promise.resolve();
            },
        };

        const engine = new MemoryEngine();
        await engine.initialize({
            adapter: mockAdapter,
            llm: new MockLLMAdapter(),
        });

        expect(calls).toEqual(["resolve"]);

        await engine.close();
        expect(calls).toEqual(["resolve", "save"]);
    });

    it("throws if neither connection nor adapter is provided", async () => {
        const engine = new MemoryEngine();
        let threw = false;
        try {
            await engine.initialize({
                llm: new MockLLMAdapter(),
            });
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
    });
});

describe("S3ConnectionAdapter", () => {
    it("derives deterministic localDir from bucket+key", () => {
        const adapter1 = new S3ConnectionAdapter({
            bucket: "my-bucket",
            key: "path/db.tar.gz",
            region: "us-east-1",
        });
        const adapter2 = new S3ConnectionAdapter({
            bucket: "my-bucket",
            key: "path/db.tar.gz",
            region: "us-east-1",
        });
        expect(adapter1.getLocalDir()).toBe(adapter2.getLocalDir());
    });

    it("uses configured localDir when provided", () => {
        const adapter = new S3ConnectionAdapter({
            bucket: "my-bucket",
            key: "path/db.tar.gz",
            region: "us-east-1",
            localDir: "/tmp/custom-dir",
        });
        expect(adapter.getLocalDir()).toBe("/tmp/custom-dir");
    });

    it("resolve returns a pglite DbConfig pointing at <localDir>/db", async () => {
        const localDir = `/tmp/memory-domain-test-${Date.now()}`;
        const adapter = new S3ConnectionAdapter({
            bucket: "nonexistent-bucket",
            key: "nonexistent.tar.gz",
            region: "us-east-1",
            localDir,
        });

        adapter._setDownloader(() => Promise.resolve(null));

        const config = await adapter.resolve();
        expect(config).toEqual({ kind: "pglite", dataDir: `${localDir}/db` });
        expect(existsSync(localDir)).toBe(true);

        rmSync(localDir, { recursive: true, force: true });
    });

    it("resolve extracts downloaded archive", async () => {
        const localDir = `/tmp/memory-domain-test-extract-${Date.now()}`;
        const archivePath = `/tmp/memory-domain-test-archive-${Date.now()}.tar.gz`;

        const sourceDir = `/tmp/memory-domain-test-source-${Date.now()}`;
        mkdirSync(join(sourceDir, "db"), { recursive: true });
        writeFileSync(join(sourceDir, "db", "testfile"), "hello");
        await tar.create({ gzip: true, file: archivePath, cwd: sourceDir }, ["db"]);

        const adapter = new S3ConnectionAdapter({
            bucket: "test",
            key: "test.tar.gz",
            region: "us-east-1",
            localDir,
        });

        const archiveBuffer = readFileSync(archivePath);
        adapter._setDownloader(() => Promise.resolve(archiveBuffer));

        const config = await adapter.resolve();
        expect(config).toEqual({ kind: "pglite", dataDir: `${localDir}/db` });
        expect(existsSync(join(localDir, "db", "testfile"))).toBe(true);

        rmSync(localDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(archivePath, { force: true });
    });

    it("save does nothing when save config is false", async () => {
        let uploaded = false;
        const adapter = new S3ConnectionAdapter({
            bucket: "test",
            key: "test.tar.gz",
            region: "us-east-1",
            save: false,
        });
        adapter._setUploader(() => {
            uploaded = true;
            return Promise.resolve();
        });

        await adapter.save();
        expect(uploaded).toBe(false);
    });

    it("save compresses and uploads when save config is true", async () => {
        const localDir = `/tmp/memory-domain-test-save-${Date.now()}`;
        mkdirSync(join(localDir, "db"), { recursive: true });
        writeFileSync(join(localDir, "db", "testfile"), "data");

        let uploadedData: Buffer | null = null;
        const adapter = new S3ConnectionAdapter({
            bucket: "test",
            key: "test.tar.gz",
            region: "us-east-1",
            localDir,
            save: true,
        });
        adapter._setUploader((data: Buffer) => {
            uploadedData = data;
            return Promise.resolve();
        });

        await adapter.save();
        expect(uploadedData).not.toBeNull();
        expect(uploadedData!.length).toBeGreaterThan(0);

        rmSync(localDir, { recursive: true, force: true });
    });
});
