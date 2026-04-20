# LLM adapters

Three `LLMAdapter` implementations ship with `@kuindji/memory-domain`:

| Adapter              | Runtime                             | When to use                                        |
|----------------------|-------------------------------------|----------------------------------------------------|
| `BedrockAdapter`     | AWS Bedrock (Claude)                | Production; cloud access to Claude.                |
| `ClaudeCliAdapter`   | `claude` CLI subprocess             | Dev; no API keys; reuses local Claude login.       |
| `OpenAiHttpAdapter`  | Any OpenAI-compatible HTTP server   | Local models (MLX/GGUF) for recipe testing.        |

## `OpenAiHttpAdapter`

Targets any server that speaks `POST /v1/chat/completions`:

- **LM Studio** — GUI + daemon, serves both MLX and GGUF.
- **`mlx_lm.server`** — from the Python `mlx-lm` package, MLX-only, CLI-only.
- **Ollama** — GGUF only (via its `/v1` compatibility endpoint).
- **llama.cpp server** (the `./server` bin from llama.cpp).
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
