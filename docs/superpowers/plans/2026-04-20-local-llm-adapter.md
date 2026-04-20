# Local LLM Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenAI-compatible HTTP `LLMAdapter` plus MLX and GGUF model-download scripts so the repo can run Qwen (and similar) models locally against LM Studio, `mlx_lm.server`, or Ollama.

**Architecture:** One new `OpenAiHttpAdapter` that speaks `/v1/chat/completions` — same prompt templates as the existing `ClaudeCliAdapter`, so recipe tests can swap adapters freely. Two new `src/bin/` scripts download MLX model directories and GGUF quant files from HuggingFace; a shared HF download helper is extracted from the existing embedding downloader. The retry loop duplicated across `bedrock.ts` and `claude-cli.ts` is extracted into a tiny shared helper while we're in there.

**Tech Stack:** TypeScript, Bun (test runner + `Bun.serve` for unit test fixtures), native `fetch`, HuggingFace `resolve/main` and `api/models/<repo>/tree/main` endpoints.

**Spec:** `docs/superpowers/specs/2026-04-20-local-llm-adapter-design.md`

---

## File Structure

**New files:**
- `src/adapters/llm/retry.ts` — shared retry helper (Task 1).
- `src/bin/_download.ts` — shared HF streaming download helper (Task 2).
- `src/adapters/llm/openai-http.ts` — the new adapter (Tasks 3–5).
- `tests/adapters/llm/openai-http.test.ts` — adapter unit tests (Tasks 3–5).
- `src/bin/download-mlx-model.ts` — MLX downloader CLI (Task 6).
- `src/bin/download-gguf-model.ts` — GGUF downloader CLI (Task 7).
- `src/adapters/llm/README.md` — short usage doc (Task 8).

**Modified files:**
- `src/adapters/llm/bedrock.ts` — consume shared retry helper (Task 1).
- `src/adapters/llm/claude-cli.ts` — consume shared retry helper (Task 1).
- `src/bin/download-model.ts` — consume shared download helper (Task 2).
- `src/index.ts` — export `OpenAiHttpAdapter` + `OpenAiHttpAdapterConfig` (Task 8).
- `package.json` — two new `bin` entries (Task 8).

---

## Task 1: Extract shared retry helper

**Files:**
- Create: `src/adapters/llm/retry.ts`
- Modify: `src/adapters/llm/bedrock.ts:22-96`
- Modify: `src/adapters/llm/claude-cli.ts:22-92`
- Test: `tests/adapters/llm/retry.test.ts` (create)

- [ ] **Step 1.1: Write the failing test**

Create `tests/adapters/llm/retry.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { runWithRetry } from "../../../src/adapters/llm/retry.js";

describe("runWithRetry", () => {
    it("returns the result on first success without delay", async () => {
        let calls = 0;
        const result = await runWithRetry(
            async () => {
                calls++;
                return "ok";
            },
            { isRetryable: () => true, label: "[test]" },
        );
        expect(result).toBe("ok");
        expect(calls).toBe(1);
    });

    it("retries retryable errors then succeeds", async () => {
        let calls = 0;
        const result = await runWithRetry(
            async () => {
                calls++;
                if (calls < 3) throw new Error("retryable");
                return "done";
            },
            {
                isRetryable: () => true,
                label: "[test]",
                baseDelayMs: 1,
                maxRetries: 3,
            },
        );
        expect(result).toBe("done");
        expect(calls).toBe(3);
    });

    it("throws immediately when error is not retryable", async () => {
        let calls = 0;
        await expect(
            runWithRetry(
                async () => {
                    calls++;
                    throw new Error("fatal");
                },
                { isRetryable: () => false, label: "[test]", baseDelayMs: 1 },
            ),
        ).rejects.toThrow("fatal");
        expect(calls).toBe(1);
    });

    it("throws the last error after maxRetries retryable failures", async () => {
        let calls = 0;
        await expect(
            runWithRetry(
                async () => {
                    calls++;
                    throw new Error(`attempt-${calls}`);
                },
                {
                    isRetryable: () => true,
                    label: "[test]",
                    baseDelayMs: 1,
                    maxRetries: 2,
                },
            ),
        ).rejects.toThrow("attempt-3");
        expect(calls).toBe(3);
    });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `bun test tests/adapters/llm/retry.test.ts`
Expected: FAIL — `Cannot find module '.../retry.js'`.

- [ ] **Step 1.3: Implement the helper**

Create `src/adapters/llm/retry.ts`:

```ts
export interface RetryOptions {
    /** Maximum number of retry attempts after the initial try. Default 3. */
    maxRetries?: number;
    /** Base delay in ms; doubles each attempt. Default 30_000. */
    baseDelayMs?: number;
    /** Predicate deciding whether an error should trigger another attempt. */
    isRetryable: (err: unknown) => boolean;
    /** Prefix used in the retry log line, e.g. "[OpenAI HTTP]". */
    label: string;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 30_000;

export async function runWithRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.log(`${opts.label} Retry ${attempt}/${maxRetries} after ${delay / 1000}s...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!opts.isRetryable(err) || attempt === maxRetries) {
                throw err;
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(`${opts.label} failed after retries`);
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `bun test tests/adapters/llm/retry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 1.5: Refactor `bedrock.ts` onto the helper**

In `src/adapters/llm/bedrock.ts`, remove the `MAX_RETRIES` / `RETRY_BASE_DELAY_MS` constants and replace the `run` method. Keep `isRetryable` as a private method so the `APIError` instanceof checks still work. New `run`:

```ts
import { runWithRetry } from "./retry.js";

// ... inside the class, replacing the existing `run` (lines ~73–96):
private async run(prompt: string): Promise<string> {
    return runWithRetry(() => this.runOnce(prompt), {
        isRetryable: (err) => this.isRetryable(err),
        label: "[Bedrock]",
    });
}
```

Delete the now-unused `MAX_RETRIES` and `RETRY_BASE_DELAY_MS` constants at the top of the file.

- [ ] **Step 1.6: Refactor `claude-cli.ts` onto the helper**

In `src/adapters/llm/claude-cli.ts`, same treatment. The existing `isRetryable(errorMessage: string)` stays private. New `run`:

```ts
import { runWithRetry } from "./retry.js";

// ... inside the class, replacing the existing `run` (lines ~69–92):
private async run(prompt: string): Promise<string> {
    return runWithRetry(() => this.runOnce(prompt), {
        isRetryable: (err) => err instanceof Error && this.isRetryable(err.message),
        label: "[Claude CLI]",
    });
}
```

Delete the now-unused `MAX_RETRIES` and `RETRY_BASE_DELAY_MS` constants.

- [ ] **Step 1.7: Run the full test suite + typecheck + lint**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green. No behavior changes to `bedrock.ts` / `claude-cli.ts`; their existing tests (if any) continue to pass.

- [ ] **Step 1.8: Commit**

```bash
git add src/adapters/llm/retry.ts src/adapters/llm/bedrock.ts src/adapters/llm/claude-cli.ts tests/adapters/llm/retry.test.ts
git commit -m "refactor(llm): extract shared retry helper used by bedrock and claude-cli adapters"
```

---

## Task 2: Extract shared HF download helper

**Files:**
- Create: `src/bin/_download.ts`
- Modify: `src/bin/download-model.ts:165-204`

No unit test here — this is a behaviour-preserving factoring of existing code, and the function touches the network / stdout. The existing downloader script is the contract; manual smoke verifies parity.

- [ ] **Step 2.1: Create the helper**

Create `src/bin/_download.ts`:

```ts
import { createWriteStream, existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { stdout } from "node:process";

export interface HfFile {
    /** File name as it should appear on disk inside the target directory. */
    name: string;
    /** Fully resolved download URL (e.g. huggingface.co/<repo>/resolve/main/<path>). */
    url: string;
}

export function formatMB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Stream a single file to `<dir>/<file.name>` via a `.partial` sidecar, with
 * progress logging to stdout. Overwrites any existing `.partial` but is a
 * no-op (unless `force` is true) if the final target already exists.
 */
export async function downloadFile(file: HfFile, dir: string, force = false): Promise<void> {
    const target = join(dir, file.name);
    if (!force && existsSync(target)) {
        stdout.write(`  ${file.name} already exists, skipping\n`);
        return;
    }

    const partial = `${target}.partial`;
    const res = await fetch(file.url);
    if (!res.ok || !res.body) {
        throw new Error(`Failed to fetch ${file.url}: ${res.status} ${res.statusText}`);
    }

    const totalHeader = res.headers.get("content-length");
    const total = totalHeader ? Number(totalHeader) : null;

    let downloaded = 0;
    let lastLogged = 0;
    const source = Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (total && stdout.isTTY && downloaded - lastLogged > 512 * 1024) {
            lastLogged = downloaded;
            stdout.write(`\r  ${file.name}  ${formatMB(downloaded)} / ${formatMB(total)}`);
        }
    });

    const sink = createWriteStream(partial);
    try {
        await finished(source.pipe(sink));
    } catch (err) {
        await rm(partial, { force: true });
        throw err;
    }

    if (stdout.isTTY && total) {
        stdout.write(`\r  ${file.name}  ${formatMB(downloaded)} / ${formatMB(total)}\n`);
    } else {
        stdout.write(`  ${file.name}  ${formatMB(downloaded)}\n`);
    }

    await rename(partial, target);
}

/** Resolve the recursive file tree of an HF repo as flat file paths (no directories). */
export async function listHfRepoFiles(repo: string, revision = "main"): Promise<string[]> {
    const out: string[] = [];
    async function walk(path: string): Promise<void> {
        const url = `https://huggingface.co/api/models/${repo}/tree/${revision}${path ? `/${path}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`HF tree listing failed for ${repo}${path ? `/${path}` : ""}: ${res.status} ${res.statusText}`);
        }
        const entries = (await res.json()) as Array<{ type: "file" | "directory"; path: string }>;
        for (const entry of entries) {
            if (entry.type === "file") {
                out.push(entry.path);
            } else if (entry.type === "directory") {
                await walk(entry.path);
            }
        }
    }
    await walk("");
    return out;
}

export function hfResolveUrl(repo: string, path: string, revision = "main"): string {
    return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}
```

- [ ] **Step 2.2: Refactor `download-model.ts` onto the helper**

In `src/bin/download-model.ts`:
1. Remove the local `formatMB` (line ~161) and the local `downloadFile` (lines ~165–204).
2. Import `downloadFile`, `formatMB` from `./_download.js`.
3. Update the call site at `main()` (around line ~217) to pass `opts.force` as the third argument and drop the now-redundant `existsSync` skip block:

```ts
for (const file of spec.files) {
    await downloadFile(file, opts.dir, opts.force);
}
```

(The helper now handles the "already exists, skipping" log internally.)

Keep everything else — `MODELS` registry, `parseOptions`, `printHelp`, `main`'s trailing summary — exactly as-is.

- [ ] **Step 2.3: Manual smoke**

Run: `bun run src/bin/download-model.ts --help`
Expected: help text matches pre-refactor output.

Run: `bun run src/bin/download-model.ts --model minilm --dir /tmp/md-smoke-$$`
Expected: downloads `model.onnx` + `vocab.txt`, prints progress, ends with size summary. Re-running the same command with no `--force` prints "already exists, skipping" for both files.

Clean up: `rm -rf /tmp/md-smoke-*`.

- [ ] **Step 2.4: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: green.

- [ ] **Step 2.5: Commit**

```bash
git add src/bin/_download.ts src/bin/download-model.ts
git commit -m "refactor(bin): extract shared HF download helper for reuse by LLM downloaders"
```

---

## Task 3: `OpenAiHttpAdapter` — happy-path `extract`

**Files:**
- Create: `src/adapters/llm/openai-http.ts`
- Test: `tests/adapters/llm/openai-http.test.ts`

TDD from here. Use `Bun.serve` on an ephemeral port inside a `beforeAll` / `afterAll` block for all openai-http tests. All following tasks add onto the same test file.

- [ ] **Step 3.1: Write the failing test**

Create `tests/adapters/llm/openai-http.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { OpenAiHttpAdapter } from "../../../src/adapters/llm/openai-http.js";

interface CapturedRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
}

let server: Server;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown } = {
    status: 200,
    body: { choices: [{ message: { content: "" } }] },
};

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => {
                headers[k] = v;
            });
            const body = await req.json().catch(() => null);
            captured.push({ method: req.method, path: url.pathname, headers, body });
            return new Response(JSON.stringify(nextResponse.body), {
                status: nextResponse.status,
                headers: { "Content-Type": "application/json" },
            });
        },
    });
    baseUrl = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
    server.stop(true);
});

function reset(): void {
    captured = [];
    nextResponse = { status: 200, body: { choices: [{ message: { content: "" } }] } };
}

function replyWith(content: string): void {
    nextResponse = { status: 200, body: { choices: [{ message: { content } }] } };
}

describe("OpenAiHttpAdapter.extract", () => {
    it("posts to /chat/completions with the configured model and parses a JSON array", async () => {
        reset();
        replyWith(`["Alice moved to Paris", "The deadline is Friday"]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "qwen2.5-3b" });

        const facts = await adapter.extract("Alice moved to Paris on Friday.");

        expect(facts).toEqual(["Alice moved to Paris", "The deadline is Friday"]);
        expect(captured).toHaveLength(1);
        expect(captured[0]!.method).toBe("POST");
        expect(captured[0]!.path).toBe("/v1/chat/completions");
        const body = captured[0]!.body as { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };
        expect(body.model).toBe("qwen2.5-3b");
        expect(body.stream).toBe(false);
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0]!.role).toBe("user");
        expect(body.messages[0]!.content).toContain("Alice moved to Paris on Friday.");
    });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `bun test tests/adapters/llm/openai-http.test.ts`
Expected: FAIL — `Cannot find module '.../openai-http.js'`.

- [ ] **Step 3.3: Implement the minimal adapter**

Create `src/adapters/llm/openai-http.ts`:

```ts
import type { LLMAdapter, ModelLevel, ScoredMemory } from "../../core/types.js";
import { parseJsonResponse } from "./json-response.js";
import { runWithRetry } from "./retry.js";

export interface OpenAiHttpAdapterConfig {
    baseUrl: string;
    model: string;
    modelLevels?: Partial<Record<ModelLevel, string>>;
    apiKey?: string;
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
    headers?: Record<string, string>;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT = 120_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

interface ChatCompletionResponse {
    choices?: Array<{ message?: { content?: string } }>;
}

class OpenAiHttpAdapter implements LLMAdapter {
    private readonly originalConfig: OpenAiHttpAdapterConfig;
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly modelLevels: Partial<Record<ModelLevel, string>> | undefined;
    private readonly apiKey: string | undefined;
    private readonly maxTokens: number;
    private readonly temperature: number;
    private readonly timeout: number;
    private readonly extraHeaders: Record<string, string>;

    constructor(config: OpenAiHttpAdapterConfig) {
        this.originalConfig = config;
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.model = config.model;
        this.modelLevels = config.modelLevels;
        this.apiKey = config.apiKey;
        this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
        this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
        this.extraHeaders = config.headers ?? {};
    }

    withLevel(level: ModelLevel): LLMAdapter {
        const model = this.modelLevels?.[level] ?? this.model;
        return new OpenAiHttpAdapter({ ...this.originalConfig, model });
    }

    private isRetryable(err: unknown): boolean {
        if (err instanceof OpenAiHttpStatusError) {
            return RETRYABLE_STATUSES.has(err.status);
        }
        if (err instanceof TypeError) return true; // fetch network error
        if (err instanceof Error && err.name === "AbortError") return true;
        return false;
    }

    private async run(prompt: string): Promise<string> {
        return runWithRetry(() => this.runOnce(prompt), {
            isRetryable: (err) => this.isRetryable(err),
            label: "[OpenAI HTTP]",
        });
    }

    private async runOnce(prompt: string): Promise<string> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...this.extraHeaders,
        };
        if (this.apiKey !== undefined && this.apiKey !== "") {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        try {
            const res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    stream: false,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const preview = (await res.text().catch(() => "")).slice(0, 500);
                throw new OpenAiHttpStatusError(res.status, preview);
            }

            const data = (await res.json()) as ChatCompletionResponse;
            const content = data.choices?.[0]?.message?.content;
            if (typeof content !== "string" || content.length === 0) {
                throw new Error(
                    `OpenAI HTTP response missing choices[0].message.content (model=${this.model})`,
                );
            }
            return content.trim();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async extract(text: string, prompt?: string): Promise<string[]> {
        const systemPrompt =
            prompt ??
            "Extract the key factual claims from the following text. Return a JSON array of strings, each being one atomic fact.";
        const fullPrompt = `${systemPrompt}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of strings.`;
        const response = await this.run(fullPrompt);
        return parseJsonResponse<string[]>(response);
    }

    async extractStructured(text: string, schema: string, prompt?: string): Promise<unknown[]> {
        const systemPrompt = prompt ?? "Extract structured information from the following text.";
        const fullPrompt = `${systemPrompt}\n\nExpected output schema for each item:\n${schema}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of objects matching the schema.`;
        const response = await this.run(fullPrompt);
        return parseJsonResponse<unknown[]>(response);
    }

    async consolidate(memories: string[]): Promise<string> {
        const memoryList = memories.map((m, i) => `${i + 1}. ${m}`).join("\n");
        const prompt = `Consolidate the following related memories into a single, comprehensive summary that preserves all important details:\n\n${memoryList}\n\nReturn ONLY the consolidated text (no JSON, no markdown).`;
        return this.run(prompt);
    }

    async assess(content: string, existingContext: string[]): Promise<number> {
        const contextBlock =
            existingContext.length > 0
                ? `\n\nExisting memories:\n${existingContext.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
                : "";
        const prompt = `Rate the novelty and importance of the following content on a scale from 0.0 to 1.0, where 0.0 means completely redundant/trivial and 1.0 means highly novel and important.${contextBlock}\n\nNew content: "${content}"\n\nReturn ONLY a JSON number between 0.0 and 1.0.`;
        const response = await this.run(prompt);
        const score = parseFloat(response.replace(/[^0-9.]/g, ""));
        return Math.max(0, Math.min(1, score));
    }

    async rerank(query: string, candidates: { id: string; content: string }[]): Promise<string[]> {
        const candidateList = candidates
            .map((c, i) => `[${i}] (id: ${c.id}) ${c.content}`)
            .join("\n");
        const prompt = `Given the query: "${query}"\n\nRerank these memory candidates by relevance. Return a JSON array of their IDs in order from most to least relevant.\n\nCandidates:\n${candidateList}\n\nReturn ONLY a JSON array of ID strings.`;
        const response = await this.run(prompt);
        return parseJsonResponse<string[]>(response);
    }

    async generate(prompt: string): Promise<string> {
        return this.run(prompt);
    }

    async synthesize(
        query: string,
        memories: ScoredMemory[],
        tagContext?: string[],
        instructions?: string,
    ): Promise<string> {
        const memoryList = memories
            .map((m, i) => `[${i + 1}] (score: ${m.score.toFixed(3)}) ${m.content}`)
            .join("\n");
        const tagBlock = tagContext?.length
            ? `\nRelevant context tags: ${tagContext.join(", ")}`
            : "";
        const baseInstructions =
            instructions ??
            "Answer the following query using ONLY the retrieved memories below.\nBe direct and concise. Cover all relevant points from the memories without adding speculation or information not present in the memories.\nIf the memories don't contain enough information to fully answer, state what's missing rather than guessing.";
        const fullPrompt = `${baseInstructions}\n\nQuery: "${query}"\n${tagBlock}\n\nRetrieved memories:\n${memoryList}`;
        return this.run(fullPrompt);
    }
}

class OpenAiHttpStatusError extends Error {
    constructor(
        public readonly status: number,
        public readonly bodyPreview: string,
    ) {
        super(`OpenAI HTTP endpoint returned ${status}: ${bodyPreview}`);
        this.name = "OpenAiHttpStatusError";
    }
}

export { OpenAiHttpAdapter };
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `bun test tests/adapters/llm/openai-http.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3.5: Commit**

```bash
git add src/adapters/llm/openai-http.ts tests/adapters/llm/openai-http.test.ts
git commit -m "feat(llm): OpenAI-compatible HTTP adapter — extract() over /v1/chat/completions"
```

---

## Task 4: `OpenAiHttpAdapter` — `extractStructured`, `rerank`, `assess`, `withLevel`, auth headers

**Files:**
- Modify: `tests/adapters/llm/openai-http.test.ts` (append)

The implementation already covers these methods from Task 3; this task locks them down with tests.

- [ ] **Step 4.1: Append the tests**

Append to `tests/adapters/llm/openai-http.test.ts`:

```ts
describe("OpenAiHttpAdapter.extractStructured", () => {
    it("parses a JSON array of objects from a fenced code block response", async () => {
        reset();
        replyWith("```json\n[{\"name\":\"Alice\",\"city\":\"Paris\"}]\n```");
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        const rows = await adapter.extractStructured("irrelevant", "{name,city}");
        expect(rows).toEqual([{ name: "Alice", city: "Paris" }]);
    });
});

describe("OpenAiHttpAdapter.rerank", () => {
    it("returns IDs in the model's returned order", async () => {
        reset();
        replyWith(`["b","a","c"]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        const order = await adapter.rerank("query", [
            { id: "a", content: "A" },
            { id: "b", content: "B" },
            { id: "c", content: "C" },
        ]);
        expect(order).toEqual(["b", "a", "c"]);
    });
});

describe("OpenAiHttpAdapter.assess", () => {
    it("parses a numeric response and clamps to [0,1]", async () => {
        reset();
        replyWith("0.73");
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        expect(await adapter.assess("new content", [])).toBeCloseTo(0.73);

        reset();
        replyWith("1.5");
        expect(await adapter.assess("x", [])).toBe(1);

        reset();
        replyWith("-0.2");
        expect(await adapter.assess("x", [])).toBe(0);
    });
});

describe("OpenAiHttpAdapter.withLevel", () => {
    it("sends the mapped model id for the requested level", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({
            baseUrl,
            model: "default-model",
            modelLevels: { low: "tiny", high: "big" },
        });
        await adapter.withLevel("high").extract("anything");
        const body = captured[0]!.body as { model: string };
        expect(body.model).toBe("big");
    });

    it("falls back to the base model when the level has no mapping", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({
            baseUrl,
            model: "default-model",
            modelLevels: { low: "tiny" },
        });
        await adapter.withLevel("medium").extract("anything");
        const body = captured[0]!.body as { model: string };
        expect(body.model).toBe("default-model");
    });
});

describe("OpenAiHttpAdapter auth headers", () => {
    it("sends Authorization: Bearer <apiKey> when apiKey is set", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m", apiKey: "lm-studio" });
        await adapter.extract("x");
        expect(captured[0]!.headers["authorization"]).toBe("Bearer lm-studio");
    });

    it("omits Authorization when apiKey is undefined", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        await adapter.extract("x");
        expect(captured[0]!.headers["authorization"]).toBeUndefined();
    });

    it("merges extra headers", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({
            baseUrl,
            model: "m",
            headers: { "X-Trace": "abc" },
        });
        await adapter.extract("x");
        expect(captured[0]!.headers["x-trace"]).toBe("abc");
    });
});
```

- [ ] **Step 4.2: Run the adapter tests**

Run: `bun test tests/adapters/llm/openai-http.test.ts`
Expected: all tests pass.

- [ ] **Step 4.3: Commit**

```bash
git add tests/adapters/llm/openai-http.test.ts
git commit -m "test(llm): OpenAI HTTP adapter — cover extractStructured, rerank, assess, withLevel, auth"
```

---

## Task 5: `OpenAiHttpAdapter` — retry and timeout

**Files:**
- Modify: `tests/adapters/llm/openai-http.test.ts` (append)

- [ ] **Step 5.1: Append the retry/timeout tests**

Append to `tests/adapters/llm/openai-http.test.ts`:

```ts
describe("OpenAiHttpAdapter retry behavior", () => {
    it("retries on 503 then succeeds when the server recovers", async () => {
        captured = [];
        // Replace the static `nextResponse` strategy with a short queue for this test
        // by switching the server's fetch handler: easiest is to keep the module-level
        // `nextResponse` but have the handler consume from a queue when it's non-empty.
        // We model that below without touching the existing helper.
        const queue: Array<{ status: number; body: unknown }> = [
            { status: 503, body: { error: "overloaded" } },
            { status: 503, body: { error: "overloaded" } },
            { status: 200, body: { choices: [{ message: { content: `["ok"]` } }] } },
        ];
        const originalFetch = server.fetch;
        // Re-stub via Bun.serve is not possible; instead we intercept by pushing
        // responses into the existing nextResponse *before* each request by
        // wrapping the adapter's fetch path.
        // Simpler: reconfigure the test server for this test.
        server.stop(true);
        server = Bun.serve({
            port: 0,
            async fetch(req) {
                const url = new URL(req.url);
                const headers: Record<string, string> = {};
                req.headers.forEach((v, k) => {
                    headers[k] = v;
                });
                const body = await req.json().catch(() => null);
                captured.push({ method: req.method, path: url.pathname, headers, body });
                const next = queue.shift() ?? { status: 500, body: {} };
                return new Response(JSON.stringify(next.body), {
                    status: next.status,
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        baseUrl = `http://localhost:${server.port}/v1`;

        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        const result = await adapter.extract("x");
        expect(result).toEqual(["ok"]);
        expect(captured.length).toBe(3);

        // Restore single-response server for subsequent tests.
        server.stop(true);
        server = Bun.serve({
            port: 0,
            async fetch(req) {
                const url = new URL(req.url);
                const headers: Record<string, string> = {};
                req.headers.forEach((v, k) => {
                    headers[k] = v;
                });
                const body = await req.json().catch(() => null);
                captured.push({ method: req.method, path: url.pathname, headers, body });
                return new Response(JSON.stringify(nextResponse.body), {
                    status: nextResponse.status,
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
        baseUrl = `http://localhost:${server.port}/v1`;
        void originalFetch; // unused
    }, 30_000);

    it("throws immediately on a non-retryable 400", async () => {
        reset();
        nextResponse = { status: 400, body: { error: "bad request" } };
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        await expect(adapter.extract("x")).rejects.toThrow(/400/);
        expect(captured.length).toBe(1);
    });

    it("throws on timeout when the server hangs", async () => {
        captured = [];
        // Spin up a hang server just for this test.
        const hangServer = Bun.serve({
            port: 0,
            async fetch() {
                await new Promise(() => {}); // never resolves
                return new Response();
            },
        });
        try {
            const adapter = new OpenAiHttpAdapter({
                baseUrl: `http://localhost:${hangServer.port}/v1`,
                model: "m",
                timeout: 50,
            });
            await expect(adapter.extract("x")).rejects.toThrow();
        } finally {
            hangServer.stop(true);
        }
    });
});
```

The retry test uses a short `baseDelayMs` via the RetryOptions default of 30s — that would be too slow. Pass a shorter delay by adding a test-only option.

> **Note:** The retry helper accepts `baseDelayMs` but the adapter doesn't currently expose it. To keep tests fast, also allow `OpenAiHttpAdapterConfig.retryBaseDelayMs` (new optional field), default 30_000, and thread it into the `runWithRetry` call. Add this to the adapter before running the test.

- [ ] **Step 5.2: Thread `retryBaseDelayMs` through the adapter**

In `src/adapters/llm/openai-http.ts`:

1. Add `retryBaseDelayMs?: number;` to `OpenAiHttpAdapterConfig`.
2. Store it: `private readonly retryBaseDelayMs: number | undefined;` in the class, set from `config.retryBaseDelayMs` in the constructor.
3. Pass through to the retry helper:

```ts
private async run(prompt: string): Promise<string> {
    return runWithRetry(() => this.runOnce(prompt), {
        isRetryable: (err) => this.isRetryable(err),
        label: "[OpenAI HTTP]",
        baseDelayMs: this.retryBaseDelayMs,
    });
}
```

Update the retry test above to construct the adapter with `retryBaseDelayMs: 1`:

```ts
const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m", retryBaseDelayMs: 1 });
```

- [ ] **Step 5.3: Run the adapter tests**

Run: `bun test tests/adapters/llm/openai-http.test.ts`
Expected: all tests pass in under ~5 seconds.

- [ ] **Step 5.4: Full suite + typecheck + lint**

Run: `bun test && bun run typecheck && bun run lint`
Expected: green.

- [ ] **Step 5.5: Commit**

```bash
git add src/adapters/llm/openai-http.ts tests/adapters/llm/openai-http.test.ts
git commit -m "feat(llm): OpenAI HTTP adapter — retry on 5xx/429, abort on timeout"
```

---

## Task 6: MLX model downloader script

**Files:**
- Create: `src/bin/download-mlx-model.ts`

No unit test — pattern follows `src/bin/download-model.ts`, which also has no tests. Manual smoke is the gate.

- [ ] **Step 6.1: Implement the script**

Create `src/bin/download-mlx-model.ts`:

```ts
#!/usr/bin/env node
/**
 * Downloads a Qwen (or similar) MLX model directory from HuggingFace into the
 * directory that an OpenAI-compatible local server (LM Studio, `mlx_lm.server`)
 * can load. Does NOT run the model — that's the server's job.
 *
 * Usage:
 *   memory-domain-download-mlx-model [--model <alias>] [--repo <hf-repo>] [--dir <path>] [--force]
 */

import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { downloadFile, formatMB, hfResolveUrl, listHfRepoFiles, type HfFile } from "./_download.js";

interface MlxModelSpec {
    repo: string;
    defaultSubdir: string;
}

const MODELS: Record<string, MlxModelSpec> = {
    "qwen2.5-1.5b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-1.5B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-1.5b-mlx-4bit",
    },
    "qwen2.5-3b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-3B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-3b-mlx-4bit",
    },
    "qwen2.5-7b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-7B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-7b-mlx-4bit",
    },
    "qwen2.5-14b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-14B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-14b-mlx-4bit",
    },
};

const DEFAULT_MODEL = "qwen2.5-3b-mlx-4bit";

interface Options {
    alias: string;
    repo: string;
    dir: string;
    force: boolean;
}

function printHelp(): void {
    const modelList = Object.entries(MODELS)
        .map(
            ([alias, spec]) =>
                `                   ${alias.padEnd(25)} → ${spec.repo}`,
        )
        .join("\n");
    stdout.write(
        [
            "Usage: memory-domain-download-mlx-model [options]",
            "",
            "Downloads an MLX model directory from HuggingFace. MLX is the Apple ML",
            "framework — on Apple Silicon it is typically 20–40% faster than GGUF",
            "at the same quant level. Run the downloaded model with LM Studio or",
            "`mlx_lm.server`, then point OpenAiHttpAdapter at its /v1 endpoint.",
            "",
            "Options:",
            `  --model <alias>  Known alias to download (default: ${DEFAULT_MODEL})`,
            modelList,
            "  --repo <hf-repo> Override the HF repo for an alias (keeps the alias as dir name)",
            "  --dir <path>     Override target directory (default: ./.memory-domain/llm-<alias>/)",
            "  --force          Re-download even if files already exist",
            "  -h, --help       Show this help",
            "",
        ].join("\n"),
    );
}

function parseOptions(args: string[]): Options {
    let alias = DEFAULT_MODEL;
    let repoOverride: string | null = null;
    let explicitDir: string | null = null;
    let force = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
            printHelp();
            exit(0);
        } else if (arg === "--force") {
            force = true;
        } else if (arg === "--model") {
            const next = args[i + 1];
            if (!next) throw new Error("--model requires an alias argument");
            if (!(next in MODELS)) {
                const known = Object.keys(MODELS).join(", ");
                throw new Error(`Unknown model alias "${next}" (known: ${known}). Use --repo to download a custom repo.`);
            }
            alias = next;
            i++;
        } else if (arg === "--repo") {
            const next = args[i + 1];
            if (!next) throw new Error("--repo requires a HuggingFace repo argument");
            repoOverride = next;
            i++;
        } else if (arg === "--dir") {
            const next = args[i + 1];
            if (!next) throw new Error("--dir requires a path argument");
            explicitDir = resolve(cwd(), next);
            i++;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    const spec = MODELS[alias];
    const repo = repoOverride ?? spec.repo;
    const dir = explicitDir ?? resolve(cwd(), ".memory-domain", spec.defaultSubdir);
    return { alias, repo, dir, force };
}

async function main(): Promise<void> {
    const opts = parseOptions(argv.slice(2));

    stdout.write(`Resolving file list for ${opts.repo}\n`);
    const paths = await listHfRepoFiles(opts.repo);
    if (paths.length === 0) {
        throw new Error(`No files found in HuggingFace repo ${opts.repo}`);
    }

    stdout.write(`Downloading ${opts.alias} (${paths.length} files) to ${opts.dir}\n`);
    await mkdir(opts.dir, { recursive: true });

    for (const path of paths) {
        const file: HfFile = { name: path, url: hfResolveUrl(opts.repo, path) };
        const subdir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (subdir) {
            await mkdir(join(opts.dir, subdir), { recursive: true });
        }
        await downloadFile(file, opts.dir, opts.force);
    }

    stdout.write("\nDone. Files:\n");
    for (const path of paths) {
        const info = await stat(join(opts.dir, path));
        stdout.write(`  ${path}  ${formatMB(info.size)}\n`);
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    exit(1);
});
```

- [ ] **Step 6.2: Typecheck**

Run: `bun run typecheck`
Expected: green.

- [ ] **Step 6.3: Smoke the help text**

Run: `bun run src/bin/download-mlx-model.ts --help`
Expected: help listing with four Qwen aliases.

- [ ] **Step 6.4 (optional, network): Smoke the smallest model**

Only if comfortable downloading ~1 GB:
Run: `bun run src/bin/download-mlx-model.ts --model qwen2.5-1.5b-mlx-4bit --dir /tmp/md-mlx-smoke`
Expected: files written under `/tmp/md-mlx-smoke`, summary printed. Skip if on a metered connection.

- [ ] **Step 6.5: Commit**

```bash
git add src/bin/download-mlx-model.ts
git commit -m "feat(bin): MLX model downloader for local LLM adapter"
```

---

## Task 7: GGUF model downloader script

**Files:**
- Create: `src/bin/download-gguf-model.ts`

- [ ] **Step 7.1: Implement the script**

Create `src/bin/download-gguf-model.ts`:

```ts
#!/usr/bin/env node
/**
 * Downloads a Qwen (or similar) GGUF quant file from HuggingFace. GGUF is the
 * llama.cpp / Ollama format. Run the downloaded file with llama.cpp server,
 * Ollama, or LM Studio, then point OpenAiHttpAdapter at its /v1 endpoint.
 *
 * Usage:
 *   memory-domain-download-gguf-model [--model <alias>] [--repo <hf-repo>] [--file <name>] [--dir <path>] [--force]
 */

import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { downloadFile, formatMB, hfResolveUrl, type HfFile } from "./_download.js";

interface GgufModelSpec {
    repo: string;
    filename: string;
    defaultSubdir: string;
}

const MODELS: Record<string, GgufModelSpec> = {
    "qwen2.5-1.5b-gguf-q4": {
        repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        defaultSubdir: "llm-qwen2.5-1.5b-gguf-q4",
    },
    "qwen2.5-3b-gguf-q4": {
        repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
        filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
        defaultSubdir: "llm-qwen2.5-3b-gguf-q4",
    },
    "qwen2.5-7b-gguf-q4": {
        repo: "Qwen/Qwen2.5-7B-Instruct-GGUF",
        filename: "qwen2.5-7b-instruct-q4_k_m.gguf",
        defaultSubdir: "llm-qwen2.5-7b-gguf-q4",
    },
};

const DEFAULT_MODEL = "qwen2.5-3b-gguf-q4";

interface Options {
    alias: string;
    repo: string;
    filename: string;
    dir: string;
    force: boolean;
}

function printHelp(): void {
    const modelList = Object.entries(MODELS)
        .map(
            ([alias, spec]) =>
                `                   ${alias.padEnd(25)} → ${spec.repo}/${spec.filename}`,
        )
        .join("\n");
    stdout.write(
        [
            "Usage: memory-domain-download-gguf-model [options]",
            "",
            "Downloads a GGUF quant file from HuggingFace. GGUF is the llama.cpp /",
            "Ollama format. Run it with llama.cpp server, Ollama, or LM Studio, then",
            "point OpenAiHttpAdapter at the server's /v1 endpoint.",
            "",
            "Options:",
            `  --model <alias>  Known alias to download (default: ${DEFAULT_MODEL})`,
            modelList,
            "  --repo <hf-repo> Override the HF repo (keeps alias as dir name)",
            "  --file <name>    Override the GGUF filename within the repo",
            "  --dir <path>     Override target directory (default: ./.memory-domain/llm-<alias>/)",
            "  --force          Re-download even if the file already exists",
            "  -h, --help       Show this help",
            "",
        ].join("\n"),
    );
}

function parseOptions(args: string[]): Options {
    let alias = DEFAULT_MODEL;
    let repoOverride: string | null = null;
    let fileOverride: string | null = null;
    let explicitDir: string | null = null;
    let force = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
            printHelp();
            exit(0);
        } else if (arg === "--force") {
            force = true;
        } else if (arg === "--model") {
            const next = args[i + 1];
            if (!next) throw new Error("--model requires an alias argument");
            if (!(next in MODELS)) {
                const known = Object.keys(MODELS).join(", ");
                throw new Error(`Unknown model alias "${next}" (known: ${known}). Use --repo and --file to download a custom quant.`);
            }
            alias = next;
            i++;
        } else if (arg === "--repo") {
            const next = args[i + 1];
            if (!next) throw new Error("--repo requires a HuggingFace repo argument");
            repoOverride = next;
            i++;
        } else if (arg === "--file") {
            const next = args[i + 1];
            if (!next) throw new Error("--file requires a filename argument");
            fileOverride = next;
            i++;
        } else if (arg === "--dir") {
            const next = args[i + 1];
            if (!next) throw new Error("--dir requires a path argument");
            explicitDir = resolve(cwd(), next);
            i++;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    const spec = MODELS[alias];
    const repo = repoOverride ?? spec.repo;
    const filename = fileOverride ?? spec.filename;
    const dir = explicitDir ?? resolve(cwd(), ".memory-domain", spec.defaultSubdir);
    return { alias, repo, filename, dir, force };
}

async function main(): Promise<void> {
    const opts = parseOptions(argv.slice(2));

    stdout.write(`Downloading ${opts.alias} (${opts.filename}) to ${opts.dir}\n`);
    await mkdir(opts.dir, { recursive: true });

    const file: HfFile = {
        name: opts.filename,
        url: hfResolveUrl(opts.repo, opts.filename),
    };
    await downloadFile(file, opts.dir, opts.force);

    stdout.write("\nDone. File:\n");
    const info = await stat(join(opts.dir, opts.filename));
    stdout.write(`  ${opts.filename}  ${formatMB(info.size)}\n`);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    exit(1);
});
```

- [ ] **Step 7.2: Typecheck**

Run: `bun run typecheck`
Expected: green.

- [ ] **Step 7.3: Smoke the help text**

Run: `bun run src/bin/download-gguf-model.ts --help`
Expected: help listing with three Qwen GGUF aliases.

- [ ] **Step 7.4: Commit**

```bash
git add src/bin/download-gguf-model.ts
git commit -m "feat(bin): GGUF model downloader for local LLM adapter"
```

---

## Task 8: Wire up exports, bin entries, and README

**Files:**
- Modify: `src/index.ts`
- Modify: `package.json`
- Create: `src/adapters/llm/README.md`

- [ ] **Step 8.1: Export the adapter**

In `src/index.ts`, add after the existing `BedrockAdapter` export block (around line 103):

```ts
export { OpenAiHttpAdapter } from "./adapters/llm/openai-http.js";
export type { OpenAiHttpAdapterConfig } from "./adapters/llm/openai-http.js";
```

- [ ] **Step 8.2: Add bin entries**

In `package.json`, extend the `bin` block:

```json
"bin": {
    "memory-domain": "dist/cli/cli.js",
    "memory-domain-tui": "dist/tui/tui.js",
    "memory-domain-download-model": "dist/bin/download-model.js",
    "memory-domain-download-mlx-model": "dist/bin/download-mlx-model.js",
    "memory-domain-download-gguf-model": "dist/bin/download-gguf-model.js"
}
```

- [ ] **Step 8.3: Write the README fragment**

Create `src/adapters/llm/README.md`:

```markdown
# LLM adapters

Three `LLMAdapter` implementations ship with `@kuindji/memory-domain`:

| Adapter              | Runtime                  | When to use                                        |
|----------------------|--------------------------|----------------------------------------------------|
| `BedrockAdapter`     | AWS Bedrock (Claude)     | Production; cloud access to Claude.                |
| `ClaudeCliAdapter`   | `claude` CLI subprocess  | Dev; no API keys; reuses local Claude login.       |
| `OpenAiHttpAdapter`  | Any OpenAI-compatible HTTP server | Local models (MLX/GGUF) for recipe testing.        |

## `OpenAiHttpAdapter`

Targets any server that speaks `POST /v1/chat/completions`:

- **LM Studio** — GUI + daemon, serves both MLX and GGUF.
- **`mlx_lm.server`** — from the Python `mlx-lm` package, MLX-only, CLI-only.
- **Ollama** — GGUF only (via its `/v1` compatibility endpoint).
- **llama.cpp server** (`./server` from llama.cpp).
- **vLLM**.

MLX vs. GGUF is a server-side choice. The adapter doesn't care.

### Recipe: Qwen2.5-3B-Instruct on Apple Silicon via `mlx_lm.server`

```bash
# 1. Download weights
bun run memory-domain-download-mlx-model --model qwen2.5-3b-mlx-4bit

# 2. Start the server (pip install mlx-lm)
mlx_lm.server --model ./.memory-domain/llm-qwen2.5-3b-mlx-4bit --port 8080

# 3. Use the adapter
```

```ts
import { OpenAiHttpAdapter } from "@kuindji/memory-domain";

const llm = new OpenAiHttpAdapter({
    baseUrl: "http://localhost:8080/v1",
    model: "qwen2.5-3b-mlx-4bit",
});

const facts = await llm.extract("Alice moved to Paris on Friday.");
```

### Recipe: GGUF via Ollama

```bash
ollama pull qwen2.5:3b-instruct-q4_K_M
```

```ts
const llm = new OpenAiHttpAdapter({
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:3b-instruct-q4_K_M",
});
```

Neither `memory-domain-download-mlx-model` nor `memory-domain-download-gguf-model` runs the model. They fetch weights; the server runs them.
```

- [ ] **Step 8.4: Verify the build**

Run: `bun run typecheck && bun run lint && bun test`
Expected: green.

Run: `bun run build`
Expected: `dist/bin/download-mlx-model.js` and `dist/bin/download-gguf-model.js` exist, `dist/adapters/llm/openai-http.js` exists.

- [ ] **Step 8.5: Format**

Run: `bun format`

- [ ] **Step 8.6: Commit**

```bash
git add src/index.ts package.json src/adapters/llm/README.md
git commit -m "feat(llm): export OpenAiHttpAdapter, register downloader bins, add usage README"
```

---

## Self-review checklist

- **Spec coverage:**
  - Adapter shape (spec §Adapter) → Tasks 3, 4, 5.
  - One-adapter-not-three (spec §Architecture) → Task 3 implementation.
  - Shared retry helper (spec §Shared retry helper) → Task 1.
  - Request shape (spec §Request shape) → Task 3 implementation + Task 4 auth-header tests.
  - MLX downloader (spec §Model download scripts) → Task 6.
  - GGUF downloader (spec §Model download scripts) → Task 7.
  - Shared HF download helper (spec §Shared helper) → Task 2.
  - Two-step reminder in docs (spec §Two-step reminder) → Task 8 README.
  - Testing plan (spec §Testing) → Tasks 3–5.
  - Package/export changes (spec §Package / export changes) → Task 8.
  - All 9 deliverables in spec §Deliverables map to tasks above.

- **Placeholder scan:** No "TBD"/"TODO"/"similar to"/"add error handling" left. Every code step shows code.

- **Type consistency:**
  - `OpenAiHttpAdapterConfig` declared in Task 3; the extra `retryBaseDelayMs` field added in Task 5 is declared explicitly in Step 5.2 before being used in the updated test.
  - `RetryOptions` in Task 1 matches its usage in Tasks 1 (bedrock/claude-cli) and 3 (adapter).
  - `HfFile` / `downloadFile` / `hfResolveUrl` / `listHfRepoFiles` / `formatMB` exports from `_download.ts` (Task 2) match imports in Tasks 6 and 7.
  - `OpenAiHttpStatusError` is defined and thrown within the same file (Task 3).
