# Connection Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `ConnectionAdapter` abstraction so the engine can transparently work with S3-hosted databases by downloading/extracting before connect and optionally uploading on close.

**Architecture:** A `ConnectionAdapter` interface with `resolve()` and `save()` methods brackets the engine's SurrealDB connection lifecycle. `PassthroughAdapter` handles native strings. `S3ConnectionAdapter` handles download/extract/upload of `.tar.gz` archives from S3. The engine always goes through an adapter.

**Tech Stack:** TypeScript, Bun, `@aws-sdk/client-s3`, `tar` (npm package)

---

### File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/types.ts` | Modify | Add `ConnectionAdapter` interface, `S3AdapterConfig` type, update `EngineConfig` |
| `src/adapters/connection/passthrough.ts` | Create | `PassthroughAdapter` implementation |
| `src/adapters/connection/s3.ts` | Create | `S3ConnectionAdapter` implementation |
| `src/core/engine.ts` | Modify | Integrate adapter into `initialize()` and `close()` |
| `src/index.ts` | Modify | Export new types and adapters |
| `tests/connection-adapter.test.ts` | Create | Tests for PassthroughAdapter, S3ConnectionAdapter, engine integration |

---

### Task 1: Add types

**Files:**
- Modify: `src/core/types.ts:327-365`

- [ ] **Step 1: Write the failing test — ConnectionAdapter type shape**

Create `tests/connection-adapter.test.ts`:

```typescript
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
        // Type-level check: this must compile
        const adapter: ConnectionAdapter = {
            resolve: () => Promise.resolve("mem://"),
            save: () => Promise.resolve(),
        };
        // EngineConfig with adapter only (no connection)
        const _config = {
            adapter,
            llm: {} as import("../src/core/types.ts").LLMAdapter,
        };
        void _config;
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/connection-adapter.test.ts`
Expected: FAIL — `ConnectionAdapter` and `S3AdapterConfig` are not exported from types.

- [ ] **Step 3: Add ConnectionAdapter interface and S3AdapterConfig to types.ts**

In `src/core/types.ts`, add after the `EmbeddingAdapter` interface (after line 346):

```typescript
// --- Connection adapter types ---

interface ConnectionAdapter {
    resolve(): Promise<string>;
    save(): Promise<void>;
}

interface S3AdapterConfig {
    bucket: string;
    key: string;
    region: string;
    localDir?: string;
    save?: boolean;
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
    };
}
```

- [ ] **Step 4: Update EngineConfig to accept optional adapter**

Change the `EngineConfig` interface so `connection` is optional and `adapter` is added:

```typescript
interface EngineConfig {
    connection?: string;
    adapter?: ConnectionAdapter;
    namespace?: string;
    database?: string;
    credentials?: { user: string; pass: string };
    llm: LLMAdapter;
    embedding?: EmbeddingAdapter;
    repetition?: RepetitionConfig;
    search?: {
        defaultMode?: "vector" | "fulltext" | "hybrid";
        defaultWeights?: { vector?: number; fulltext?: number; graph?: number };
        defaultEf?: number;
    };
    context?: RequestContext;
    debug?: DebugConfig;
}
```

- [ ] **Step 5: Export the new types from types.ts**

Add `ConnectionAdapter` and `S3AdapterConfig` to the exports in `src/core/types.ts`.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/connection-adapter.test.ts`
Expected: PASS — all 3 type tests pass.

- [ ] **Step 7: Run typecheck to verify nothing broke**

Run: `bun run typecheck`
Expected: PASS — existing code still compiles. The `connection` field is now optional, but all existing call sites provide it so no breakage.

- [ ] **Step 8: Commit**

```bash
bun format
git add src/core/types.ts tests/connection-adapter.test.ts
git commit -m "Add ConnectionAdapter interface and S3AdapterConfig type"
```

---

### Task 2: Implement PassthroughAdapter

**Files:**
- Create: `src/adapters/connection/passthrough.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/connection-adapter.test.ts`:

```typescript
import { PassthroughAdapter } from "../src/adapters/connection/passthrough.ts";

describe("PassthroughAdapter", () => {
    it("resolve returns the connection string unchanged", async () => {
        const adapter = new PassthroughAdapter("surrealkv:///path/to/db");
        const result = await adapter.resolve();
        expect(result).toBe("surrealkv:///path/to/db");
    });

    it("save is a no-op", async () => {
        const adapter = new PassthroughAdapter("mem://");
        await adapter.save(); // should not throw
    });

    it("implements ConnectionAdapter", () => {
        const adapter: ConnectionAdapter = new PassthroughAdapter("mem://");
        expect(typeof adapter.resolve).toBe("function");
        expect(typeof adapter.save).toBe("function");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/connection-adapter.test.ts`
Expected: FAIL — cannot resolve `../src/adapters/connection/passthrough.ts`.

- [ ] **Step 3: Implement PassthroughAdapter**

Create `src/adapters/connection/passthrough.ts`:

```typescript
import type { ConnectionAdapter } from "../../core/types.ts";

class PassthroughAdapter implements ConnectionAdapter {
    private connection: string;

    constructor(connection: string) {
        this.connection = connection;
    }

    async resolve(): Promise<string> {
        return this.connection;
    }

    async save(): Promise<void> {}
}

export { PassthroughAdapter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/connection-adapter.test.ts`
Expected: PASS — all PassthroughAdapter tests pass.

- [ ] **Step 5: Commit**

```bash
bun format
git add src/adapters/connection/passthrough.ts tests/connection-adapter.test.ts
git commit -m "Add PassthroughAdapter for native connection strings"
```

---

### Task 3: Integrate adapter into engine

**Files:**
- Modify: `src/core/engine.ts:44-111` (member declaration and `initialize()`)
- Modify: `src/core/engine.ts:1252-1258` (`close()`)

- [ ] **Step 1: Write the failing test — engine uses adapter**

Add to `tests/connection-adapter.test.ts`:

```typescript
import { MemoryEngine } from "../src/core/engine.ts";
import { MockLLMAdapter } from "./helpers.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/connection-adapter.test.ts`
Expected: FAIL — engine doesn't know about `adapter` field yet.

- [ ] **Step 3: Add adapter member to MemoryEngine**

In `src/core/engine.ts`, add a private member after the existing declarations (around line 46):

```typescript
private adapter?: ConnectionAdapter;
```

Add `ConnectionAdapter` to the imports from `./types.ts`, and add `PassthroughAdapter` import:

```typescript
import { PassthroughAdapter } from "../adapters/connection/passthrough.ts";
```

- [ ] **Step 4: Update initialize() to use adapter**

Replace the connection logic at the start of `initialize()` (lines 61-67):

```typescript
async initialize(config: EngineConfig): Promise<void> {
    if (!config.connection && !config.adapter) {
        throw new Error("EngineConfig requires either 'connection' or 'adapter'");
    }

    this.adapter = config.adapter ?? new PassthroughAdapter(config.connection!);
    const connectionString = await this.adapter.resolve();

    const db = new Surreal({ engines: createNodeEngines() });
    await db.connect(connectionString);
    await db.use({
        namespace: config.namespace ?? "default",
        database: config.database ?? "memory",
    });
    // ... rest unchanged
```

- [ ] **Step 5: Update close() to call adapter.save()**

Replace the `close()` method (lines 1252-1258):

```typescript
async close(): Promise<void> {
    this.stopProcessing();
    if (this.adapter) {
        await this.adapter.save();
    }
    if (this.db) {
        await this.db.close();
        this.db = null;
    }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/connection-adapter.test.ts`
Expected: PASS — all engine integration tests pass.

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `bun test`
Expected: PASS — all existing tests still work (they all provide `connection` in their config).

- [ ] **Step 8: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
bun format
git add src/core/engine.ts tests/connection-adapter.test.ts
git commit -m "Integrate ConnectionAdapter into engine lifecycle"
```

---

### Task 4: Install S3 and tar dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

Run: `bun add @aws-sdk/client-s3 tar`

- [ ] **Step 2: Install type definitions for tar**

Run: `bun add -d @types/tar`

- [ ] **Step 3: Verify installation**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "Add @aws-sdk/client-s3 and tar dependencies"
```

---

### Task 5: Implement S3ConnectionAdapter

**Files:**
- Create: `src/adapters/connection/s3.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/connection-adapter.test.ts`:

```typescript
import { S3ConnectionAdapter } from "../src/adapters/connection/s3.ts";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import * as tar from "tar";

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
        // Both should derive the same localDir
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

    it("resolve returns surrealkv connection string", async () => {
        const localDir = `/tmp/memory-domain-test-${Date.now()}`;
        const adapter = new S3ConnectionAdapter({
            bucket: "nonexistent-bucket",
            key: "nonexistent.tar.gz",
            region: "us-east-1",
            localDir,
        });

        // Mock the S3 download to simulate 404 (fresh database)
        adapter._setDownloader(async () => null);

        const connectionString = await adapter.resolve();
        expect(connectionString).toBe(`surrealkv://${localDir}/db`);
        expect(existsSync(localDir)).toBe(true);

        // Cleanup
        rmSync(localDir, { recursive: true, force: true });
    });

    it("resolve extracts downloaded archive", async () => {
        const localDir = `/tmp/memory-domain-test-extract-${Date.now()}`;
        const archivePath = `/tmp/memory-domain-test-archive-${Date.now()}.tar.gz`;

        // Create a test archive
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

        // Mock downloader to return our test archive
        const { readFileSync } = await import("fs");
        const archiveBuffer = readFileSync(archivePath);
        adapter._setDownloader(async () => archiveBuffer);

        const connectionString = await adapter.resolve();
        expect(connectionString).toBe(`surrealkv://${localDir}/db`);
        expect(existsSync(join(localDir, "db", "testfile"))).toBe(true);

        // Cleanup
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
        adapter._setUploader(async () => {
            uploaded = true;
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
        adapter._setUploader(async (data: Buffer) => {
            uploadedData = data;
        });

        await adapter.save();
        expect(uploadedData).not.toBeNull();
        expect(uploadedData!.length).toBeGreaterThan(0);

        // Cleanup
        rmSync(localDir, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/connection-adapter.test.ts`
Expected: FAIL — cannot resolve `../src/adapters/connection/s3.ts`.

- [ ] **Step 3: Implement S3ConnectionAdapter**

Create `src/adapters/connection/s3.ts`:

```typescript
import { createHash } from "crypto";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as tar from "tar";
import type { ConnectionAdapter, S3AdapterConfig } from "../../core/types.ts";

type Downloader = () => Promise<Buffer | null>;
type Uploader = (data: Buffer) => Promise<void>;

class S3ConnectionAdapter implements ConnectionAdapter {
    private config: S3AdapterConfig;
    private localDir: string;
    private downloader: Downloader;
    private uploader: Uploader;

    constructor(config: S3AdapterConfig) {
        this.config = config;
        this.localDir = config.localDir ?? this.deriveLocalDir();

        const client = new S3Client({
            region: config.region,
            ...(config.credentials && {
                credentials: {
                    accessKeyId: config.credentials.accessKeyId,
                    secretAccessKey: config.credentials.secretAccessKey,
                },
            }),
        });

        this.downloader = async () => {
            try {
                const response = await client.send(
                    new GetObjectCommand({
                        Bucket: config.bucket,
                        Key: config.key,
                    }),
                );
                if (!response.Body) return null;
                const chunks: Uint8Array[] = [];
                for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks);
            } catch (err: unknown) {
                const error = err as { name?: string };
                if (error.name === "NoSuchKey" || error.name === "NotFound") {
                    return null;
                }
                throw new Error(
                    `Failed to download s3://${config.bucket}/${config.key}: ${err}`,
                );
            }
        };

        this.uploader = async (data: Buffer) => {
            try {
                await client.send(
                    new PutObjectCommand({
                        Bucket: config.bucket,
                        Key: config.key,
                        Body: data,
                    }),
                );
            } catch (err) {
                throw new Error(
                    `Failed to upload to s3://${config.bucket}/${config.key}: ${err}`,
                );
            }
        };
    }

    getLocalDir(): string {
        return this.localDir;
    }

    async resolve(): Promise<string> {
        mkdirSync(this.localDir, { recursive: true });

        const archive = await this.downloader();
        if (archive) {
            await this.extract(archive);
        }

        return `surrealkv://${this.localDir}/db`;
    }

    async save(): Promise<void> {
        if (!this.config.save) return;

        const archive = await this.compress();
        await this.uploader(archive);
    }

    /** @internal — for testing only */
    _setDownloader(fn: Downloader): void {
        this.downloader = fn;
    }

    /** @internal — for testing only */
    _setUploader(fn: Uploader): void {
        this.uploader = fn;
    }

    private deriveLocalDir(): string {
        const hash = createHash("sha256")
            .update(`${this.config.bucket}/${this.config.key}`)
            .digest("hex")
            .slice(0, 12);
        return join(tmpdir(), `memory-domain-${hash}`);
    }

    private async extract(archive: Buffer): Promise<void> {
        const stream = Readable.from(archive);
        await pipeline(stream, createGunzip(), tar.extract({ cwd: this.localDir }));
    }

    private async compress(): Promise<Buffer> {
        const chunks: Uint8Array[] = [];
        const stream = tar.create({ gzip: true, cwd: this.localDir }, ["db"]);
        for await (const chunk of stream) {
            chunks.push(chunk as Uint8Array);
        }
        return Buffer.concat(chunks);
    }
}

export { S3ConnectionAdapter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/connection-adapter.test.ts`
Expected: PASS — all S3ConnectionAdapter tests pass.

- [ ] **Step 5: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun format
git add src/adapters/connection/s3.ts tests/connection-adapter.test.ts
git commit -m "Add S3ConnectionAdapter for remote database storage"
```

---

### Task 6: Update exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add new exports to src/index.ts**

Add to the Types section:

```typescript
export type { ConnectionAdapter, S3AdapterConfig } from "./core/types.ts";
```

Add to the Adapters section:

```typescript
export { PassthroughAdapter } from "./adapters/connection/passthrough.ts";
export { S3ConnectionAdapter } from "./adapters/connection/s3.ts";
```

- [ ] **Step 2: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: PASS — everything works together.

- [ ] **Step 4: Commit**

```bash
bun format
git add src/index.ts
git commit -m "Export ConnectionAdapter types and adapter implementations"
```
