import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryConnectionAdapter } from "../../../src/adapters/connection/directory.js";
import type { ConnectionAdapter } from "../../../src/core/types.js";

describe("DirectoryConnectionAdapter", () => {
    let dir: string;

    beforeEach(() => {
        dir = join(tmpdir(), `md-dir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    });

    afterEach(() => {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    });

    it("resolve returns a pglite DbConfig under path/db when db subdir exists", async () => {
        mkdirSync(join(dir, "db"), { recursive: true });
        const adapter = new DirectoryConnectionAdapter({ path: dir });
        const config = await adapter.resolve();
        expect(config).toEqual({ kind: "pglite", dataDir: join(dir, "db") });
    });

    it("getLocalDir returns the configured path", () => {
        const adapter = new DirectoryConnectionAdapter({ path: dir });
        expect(adapter.getLocalDir()).toBe(dir);
    });

    it("save is a no-op", async () => {
        mkdirSync(join(dir, "db"), { recursive: true });
        const adapter = new DirectoryConnectionAdapter({ path: dir });
        const result = await adapter.save();
        expect(result).toBeUndefined();
    });

    it("resolve rejects clearly when path/db does not exist", async () => {
        const adapter = new DirectoryConnectionAdapter({ path: dir });
        let error: Error | undefined;
        try {
            await adapter.resolve();
        } catch (err) {
            error = err as Error;
        }
        expect(error).toBeDefined();
        expect(error?.message).toMatch(/does not exist/i);
    });

    it("implements ConnectionAdapter", () => {
        mkdirSync(join(dir, "db"), { recursive: true });
        const adapter: ConnectionAdapter = new DirectoryConnectionAdapter({ path: dir });
        expect(typeof adapter.resolve).toBe("function");
        expect(typeof adapter.save).toBe("function");
    });
});
