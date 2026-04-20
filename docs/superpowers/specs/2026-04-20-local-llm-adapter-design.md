# Local LLM adapter — design spec

**Date:** 2026-04-20
**Status:** Approved for implementation planning

## Motivation

Recipe-testing against the ideas in `docs/research/atlas.md` will require many LLM calls (atomic-fact extraction, contradiction adjudication, reranking, synthesis). Running those through `ClaudeCliAdapter` or `BedrockAdapter` is slow, metered, and couples experimentation to a cloud vendor. A local-LLM path unblocks free, fast iteration on Apple Silicon, where Qwen2.5-family instruction-tuned models run well.

We expect to use Qwen2.5 models primarily. On Apple Silicon, the **MLX** format (Apple's ML framework) is typically 20–40% faster than GGUF/llama.cpp for the same quant level, and Qwen has first-class MLX ports under `mlx-community/`. We want to be able to use either MLX or GGUF without writing a second adapter.

## Scope

**In:**
- One new `LLMAdapter` implementation that speaks the OpenAI `/v1/chat/completions` HTTP shape, usable against LM Studio, `mlx_lm.server`, Ollama (`/v1`), llama.cpp server, and vLLM.
- Two model-download scripts — one for MLX model directories, one for single-file GGUF quants — following the pattern of the existing `src/bin/download-model.ts` embedding downloader.
- Small incidental refactor: extract the duplicated retry loop out of `bedrock.ts` / `claude-cli.ts` into a shared helper; extract the HF download helper out of `download-model.ts`.

**Out:**
- No in-process runtimes (no `node-llama-cpp`, no transformers.js LLM path).
- No streaming (`LLMAdapter` methods are `Promise<T>`; streaming is not required for recipe-testing).
- No embeddings via this adapter. Embeddings stay on `OnnxEmbeddingAdapter`.
- No auto-starting of LM Studio or `mlx_lm.server`. The user launches the server out-of-band (same pattern as `claude-cli.ts` depending on the `claude` binary being on PATH).
- No changes to `docs/research/atlas.md` in this spec. Recipe-testing work that lands after the adapter will cite it.

## Architecture

### One adapter, not three

MLX vs. GGUF is a **server-side** choice. LM Studio serves both formats over the same OpenAI-compatible endpoint. `mlx_lm.server` serves MLX only, over the same shape. Ollama serves GGUF, also over an OpenAI-compatible `/v1` endpoint. Therefore one adapter targets all of them — users pick runtime by changing `baseUrl` and `model`, not by picking a different adapter class.

If a future runtime doesn't speak OpenAI HTTP (e.g. direct `node-llama-cpp` in-process), that will get its own adapter file. The `src/adapters/llm/` directory already supports multiple sibling implementations (`bedrock.ts`, `claude-cli.ts`).

### Adapter: `src/adapters/llm/openai-http.ts`

Exports `OpenAiHttpAdapter implements LLMAdapter` and `OpenAiHttpAdapterConfig`.

```ts
interface OpenAiHttpAdapterConfig {
    baseUrl: string;                                    // e.g. "http://localhost:1234/v1"
    model: string;                                      // e.g. "mlx-community/Qwen2.5-3B-Instruct-4bit"
    modelLevels?: Partial<Record<ModelLevel, string>>;
    apiKey?: string;                                    // optional; LM Studio ignores, some servers want a dummy
    maxTokens?: number;                                 // default 4096
    temperature?: number;                               // default 0.0
    timeout?: number;                                   // default 120_000 ms
    headers?: Record<string, string>;                   // extra headers, merged over Authorization
}
```

Interface conformance (from `src/core/types.ts:371`):

- `extract(text, prompt?)` — same prompt template as `claude-cli.ts`, response parsed via `parseJsonResponse<string[]>`.
- `extractStructured(text, schema, prompt?)` — same, parsed via `parseJsonResponse<unknown[]>`.
- `consolidate(memories)` — returns trimmed text.
- `assess(content, existingContext)` — returns a number clamped to `[0, 1]`.
- `rerank(query, candidates)` — returns `string[]` of IDs.
- `synthesize(query, memories, tagContext?, instructions?)` — returns text.
- `generate(prompt)` — returns text.
- `withLevel(level)` — clones the adapter with `model = modelLevels?.[level] ?? model`, matching `BedrockAdapter.withLevel` in `src/adapters/llm/bedrock.ts:58`.

Prompt bodies are copied verbatim from `claude-cli.ts` so the two adapters are swap-compatible in recipe tests.

### Request shape

```
POST {baseUrl}/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer {apiKey || "not-needed"}   // omit header if apiKey === ""
  ...headers
Body:
  {
    "model": "<resolved model>",
    "messages": [{ "role": "user", "content": "<prompt>" }],
    "max_tokens": <maxTokens>,
    "temperature": <temperature>,
    "stream": false
  }
```

Response path: `response.choices[0].message.content`. Any other shape is a hard error with a message preview (same pattern as `claude-cli.ts:137`).

### Shared retry helper: `src/adapters/llm/retry.ts`

`bedrock.ts` and `claude-cli.ts` both carry near-identical retry loops (`MAX_RETRIES = 3`, `RETRY_BASE_DELAY_MS = 30_000`, exponential backoff). Extract into:

```ts
export interface RetryOptions {
    maxRetries?: number;       // default 3
    baseDelayMs?: number;      // default 30_000
    isRetryable: (err: unknown) => boolean;
    label: string;             // for log prefix, e.g. "[OpenAI HTTP]"
}

export async function runWithRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T>;
```

`bedrock.ts` and `claude-cli.ts` are refactored to consume it. Their `isRetryable` predicates stay adapter-local (one matches `APIError` instances, the other matches stderr substrings). Behavior must be byte-identical to the current code — this is a refactor, not a change.

`OpenAiHttpAdapter.isRetryable` matches: network errors (`TypeError` from `fetch`), HTTP status 408, 429, 500, 502, 503, 504, 529.

## Model download scripts

Two new bins, each mirroring `src/bin/download-model.ts` in style. Both resolve to `./.memory-domain/llm-<alias>/` by default.

### `src/bin/download-mlx-model.ts` — `memory-domain-download-mlx-model`

MLX models need multiple files: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, and either `model.safetensors` or sharded `model-00001-of-000NN.safetensors` + `model.safetensors.index.json`. Because the shard count varies per model, the script resolves the actual file list from `https://huggingface.co/api/models/<repo>/tree/main` and then downloads each entry via `https://huggingface.co/<repo>/resolve/main/<path>`.

Alias registry (initial):

| Alias                    | HuggingFace repo                                 |
|--------------------------|--------------------------------------------------|
| `qwen2.5-1.5b-mlx-4bit`  | `mlx-community/Qwen2.5-1.5B-Instruct-4bit`       |
| `qwen2.5-3b-mlx-4bit`    | `mlx-community/Qwen2.5-3B-Instruct-4bit`         |
| `qwen2.5-7b-mlx-4bit`    | `mlx-community/Qwen2.5-7B-Instruct-4bit`         |
| `qwen2.5-14b-mlx-4bit`   | `mlx-community/Qwen2.5-14B-Instruct-4bit`        |

Flags: `--model <alias>`, `--repo <hf-repo>` (override registry; alias becomes required for naming the dir), `--dir <path>`, `--force`, `-h | --help`.

### `src/bin/download-gguf-model.ts` — `memory-domain-download-gguf-model`

GGUF is one `.gguf` file per quant. Registry maps alias → `{ repo, filename }`:

| Alias                  | Repo                              | Filename                                  |
|------------------------|-----------------------------------|-------------------------------------------|
| `qwen2.5-1.5b-gguf-q4` | `Qwen/Qwen2.5-1.5B-Instruct-GGUF` | `qwen2.5-1.5b-instruct-q4_k_m.gguf`       |
| `qwen2.5-3b-gguf-q4`   | `Qwen/Qwen2.5-3B-Instruct-GGUF`   | `qwen2.5-3b-instruct-q4_k_m.gguf`         |
| `qwen2.5-7b-gguf-q4`   | `Qwen/Qwen2.5-7B-Instruct-GGUF`   | `qwen2.5-7b-instruct-q4_k_m.gguf`         |

Flags: same as MLX script, plus `--repo` and `--file` overrides.

### Shared helper: `src/bin/_download.ts`

Factor the streaming progress-reporting `downloadFile` out of `src/bin/download-model.ts:165` so all three scripts use the same implementation. Existing `download-model.ts` is refactored to consume it; behavior unchanged.

### Two-step reminder

Neither download script runs the model. The server (LM Studio, `mlx_lm.server`, Ollama, llama.cpp server) is the thing that serves `/v1/chat/completions`. The scripts' `--help` output and the adapter's JSDoc both say so explicitly, with a minimal recipe:

```
# Download weights
bun run memory-domain-download-mlx-model --model qwen2.5-3b-mlx-4bit

# Start server (one of these, user's choice)
mlx_lm.server --model ./.memory-domain/llm-qwen2.5-3b-mlx-4bit --port 8080
# or launch LM Studio and point it at the folder

# Configure adapter
new OpenAiHttpAdapter({
    baseUrl: "http://localhost:8080/v1",
    model: "qwen2.5-3b-mlx-4bit",
})
```

## Testing

Unit tests at `tests/adapters/llm/openai-http.test.ts` using a short-lived `Bun.serve` fixture on an ephemeral port. Coverage:

- Request shape: method, path, headers (including `Authorization` presence/absence), body fields.
- `extract` parses a JSON-array response and returns `string[]`.
- `extractStructured` parses a JSON-array-of-objects response.
- `rerank` returns IDs in model order.
- `assess` clamps to `[0, 1]`.
- `withLevel(level)` calls the server with the mapped model id.
- Retry: server returns 503 twice then 200; adapter succeeds. Server returns 429 with a non-retryable body once the retries are exhausted; adapter throws.
- Timeout: server hangs past `timeout`; adapter throws a timeout error with a recognizable message.

No CI integration test against a real local server. A gated integration test (env var `MEMORY_DOMAIN_LOCAL_LLM_URL`) is optional — add it only when recipe-testing first consumes it.

## Package / export changes

- `package.json` gains two `bin` entries: `memory-domain-download-mlx-model` and `memory-domain-download-gguf-model`, both pointing into `dist/bin/` (parallel to the existing embedding downloader).
- `src/index.ts` exports `OpenAiHttpAdapter` and `OpenAiHttpAdapterConfig` next to the existing `BedrockAdapter` / `ClaudeCliAdapter` exports.
- No new runtime dependencies. Native `fetch` on Bun/Node 20+.

## Relation to existing systems

- Parallel to `BedrockAdapter` (cloud) and `ClaudeCliAdapter` (process). All three conform to `LLMAdapter` from `src/core/types.ts:371`.
- Parallel to `OnnxEmbeddingAdapter` on the embedding side: both are "local, deterministic, no per-call billing" paths. The embedding adapter is in-process ONNX; the LLM adapter is out-of-process HTTP because Node LLM inference lacks a mature in-process story for MLX.
- Download scripts parallel to `src/bin/download-model.ts` and share its HF-resolve URL pattern.

## Deliverables

1. `src/adapters/llm/openai-http.ts` — the adapter.
2. `src/adapters/llm/retry.ts` — shared retry helper; `bedrock.ts` and `claude-cli.ts` refactored onto it (behavior-preserving).
3. `src/bin/download-mlx-model.ts` — MLX downloader.
4. `src/bin/download-gguf-model.ts` — GGUF downloader.
5. `src/bin/_download.ts` — shared HF-download helper; `download-model.ts` refactored onto it (behavior-preserving).
6. `package.json` — two new `bin` entries.
7. `src/index.ts` — export `OpenAiHttpAdapter` + `OpenAiHttpAdapterConfig`.
8. `tests/adapters/llm/openai-http.test.ts` — unit tests.
9. `src/adapters/llm/README.md` — short usage doc naming the three supported server options and a minimal MLX+Qwen recipe.

## Success criteria

- `bun test` passes, including the new unit tests.
- `bun run lint` and `bun run typecheck` clean (no new `as any`, no new eslint disables).
- `bedrock.ts` and `claude-cli.ts` retry behavior observationally identical to pre-refactor (covered by their existing tests, which must keep passing).
- Manual smoke: download `qwen2.5-3b-mlx-4bit`, run it behind `mlx_lm.server` or LM Studio, construct `OpenAiHttpAdapter`, run `extract` on a short paragraph, receive a JSON array of facts.
