# @kuindji/memory-domain

A domain-driven memory engine with graph storage, embeddings, and semantic search. Built on SurrealDB.

## Features

- **Domain-based architecture** — memories are organized into bounded domains (topics, users, code repos, knowledge base) that define their own processing, search, and scheduling logic
- **Graph data model** — memories, tags, and domains form a rich graph with typed edges (reinforces, contradicts, summarizes, refines)
- **Hybrid search** — combines vector similarity, full-text search, and graph traversal
- **Inbox processing** — parallel ingestion pipeline with similarity batching and deduplication
- **LLM integration** — pluggable LLM adapters; ships with `ClaudeCliAdapter` (local `claude` CLI) and `BedrockAdapter` (Amazon Bedrock via the Anthropic SDK)
- **Embedding support** — ONNX-based local embeddings via `onnxruntime-node`
- **Portable databases** — connection adapters for embedded surrealkv, local tar.gz archives, and S3-backed snapshots

## Installation

```bash
npm install @kuindji/memory-domain
```

### First-time setup: download the embedding model

`OnnxEmbeddingAdapter` needs a BERT-family ONNX encoder and its vocab file. Fetch them with:

```bash
npx memory-domain-download-model                     # default: all-MiniLM-L6-v2 (~86 MB, mean-pooled)
npx memory-domain-download-model --model bge-small   # BAAI/bge-small-en-v1.5 (~133 MB, CLS-pooled)
# or to a custom location:
npx memory-domain-download-model --dir ./my-models
```

By default MiniLM writes to `./.memory-domain/model/` and BGE-small writes to `./.memory-domain/model-bge-small/` relative to the current directory. `new OnnxEmbeddingAdapter()` defaults to the MiniLM path; point it elsewhere via `new OnnxEmbeddingAdapter({ modelDir: "./my-models" })`. BGE-small requires `pooling: "cls"` to match its training objective; MiniLM stays on the default `"mean"`.

## Quick Start

```typescript
import {
    MemoryEngine,
    topicDomain,
    ClaudeCliAdapter,
    OnnxEmbeddingAdapter,
} from "@kuindji/memory-domain";

const engine = new MemoryEngine();

await engine.initialize({
    connection: "surrealkv:///tmp/memories/db", // embedded; or "ws://localhost:8000" for a remote SurrealDB
    namespace: "my_app",
    database: "memories",
    llm: new ClaudeCliAdapter(),
    embedding: new OnnxEmbeddingAdapter(),
});

await engine.registerDomain(topicDomain);

// Ingest a memory
await engine.ingest("TypeScript 5.5 introduces inferred type predicates");

// Search
const results = await engine.search("TypeScript features");

// Ask a question
const answer = await engine.ask("What do I know about TypeScript?");
```

### Using Amazon Bedrock instead of the Claude CLI

```typescript
import { BedrockAdapter } from "@kuindji/memory-domain";

const llm = new BedrockAdapter({
    modelId: "eu.anthropic.claude-sonnet-4-6",
    region: "eu-west-2",
    profile: "my-aws-profile", // or pass `credentials`, or omit to use the default chain
    modelLevels: {
        low: "eu.anthropic.claude-haiku-4-5",
        medium: "eu.anthropic.claude-sonnet-4-6",
        high: "eu.anthropic.claude-opus-4-6-v1",
    },
});
```

`BedrockAdapter` implements the same `LLMAdapter` interface as `ClaudeCliAdapter`, so it's a drop-in swap.

## CLI

The package includes CLI tools:

```bash
# CLI
npx memory-domain --help
npx memory-domain ingest --text "Some memory to store"
npx memory-domain search --query "find something"

# Interactive TUI
npx memory-domain-tui
```

## Configuration

The CLI and TUI look for a `memory-domain.config.ts` (or `.js` / `.mjs`) file in your project root. The module must default-export a fully-initialized `MemoryEngine` instance — use top-level `await` to initialize and register domains before exporting:

```typescript
import {
    MemoryEngine,
    topicDomain,
    ClaudeCliAdapter,
    OnnxEmbeddingAdapter,
} from "@kuindji/memory-domain";

const engine = new MemoryEngine();

await engine.initialize({
    connection: "surrealkv:///tmp/memories/db",
    namespace: "default",
    database: "memory",
    llm: new ClaudeCliAdapter(),
    embedding: new OnnxEmbeddingAdapter(),
});

await engine.registerDomain(topicDomain);

export default engine;
```

## Connection adapters

`EngineConfig.adapter` accepts a `ConnectionAdapter` that resolves to a SurrealDB connection string at startup and can optionally persist the database back on `engine.close()`. The package ships three:

- **`PassthroughAdapter(connectionString)`** — just returns the string you gave it. Use when you already have a SurrealDB URL (remote server, file path, in-memory).
- **`FileConnectionAdapter({ file, localDir?, save? })`** — extracts a local `.tar.gz` archive to a working directory and exposes it as `surrealkv://<dir>/db`. Set `save: true` to recompress on close. Ideal for shipping prebuilt KBs alongside your code.
- **`S3ConnectionAdapter({ bucket, key, region, profile?, credentials?, save? })`** — same shape but fetches/uploads the archive from S3.
- **`DirectoryConnectionAdapter({ path })`** — opens a pre-extracted `path/db/` directory in place. Read-intended; `save()` is a no-op. Use when a container image bakes the DB alongside the code and you want to skip tar extraction on cold start. Do not open the same path twice in one process — SurrealKV expects exclusive access.

```typescript
import { MemoryEngine, FileConnectionAdapter, BedrockAdapter } from "@kuindji/memory-domain";

const engine = new MemoryEngine();
await engine.initialize({
    adapter: new FileConnectionAdapter({ file: "./kb.tar.gz" }),
    namespace: "my_app",
    database: "kb",
    llm: new BedrockAdapter({
        modelId: "eu.anthropic.claude-sonnet-4-6",
        region: "eu-west-2",
        profile: "my-aws-profile",
    }),
});
```

## Programmatic usage

The CLI is one of several transports over a shared command dispatcher. You can use memory-domain as a library to serve the same command surface over a Lambda, HTTP server, or any other runtime without shelling out.

### Lambda with a baked-in knowledge base

```typescript
import {
    MemoryEngine,
    DirectoryConnectionAdapter,
    BedrockAdapter,
    OnnxEmbeddingAdapter,
    createKbDomain,
    createLambdaAdapter,
} from "@kuindji/memory-domain";

// Construct once at module scope; reused across warm invocations.
const handlerPromise = (async () => {
    const engine = new MemoryEngine();
    await engine.initialize({
        adapter: new DirectoryConnectionAdapter({ path: "/var/task/kb" }),
        namespace: "my_app",
        database: "business",
        llm: new BedrockAdapter({
            modelId: "eu.anthropic.claude-sonnet-4-6",
            region: "eu-west-2",
        }),
        embedding: new OnnxEmbeddingAdapter({ modelDir: "/var/task/kb/model" }),
    });
    await engine.registerDomain(createKbDomain());
    return createLambdaAdapter(engine); // defaults to the read-only profile
})();

export const handler = async (event: { command: string; args: string[] }) => {
    const lambdaHandler = await handlerPromise;
    return lambdaHandler(event);
};
```

The default profile exposes the read-side commands: `search`, `build-context`, `memory`, `graph`, `skill`, `domains`, `domain`. Pass `{ profile: "full" }` to expose every command, or `{ profile: [...] }` for a custom allow list. The returned `DispatchResult` carries both the raw `output` (structured data) and `rendered` (a pre-rendered JSON or pretty string), so callers can use whichever form they need.

**Invocation shape:** `event.args` is the argv tail *including flags*, e.g. `{ command: "search", args: ["query text", "--limit", "5"] }`. Flags must be encoded as argv strings, matching the CLI's input contract.

**Lifecycle:** `createLambdaAdapter` never calls `engine.close()`. Construct the engine once at module scope and rely on Lambda's execution-environment reuse. Cold-start engine-init errors propagate out of `engine.initialize()` so Lambda marks the container as failed; per-invocation errors resolve as `{ ok: false, error: { code, message } }`.

## Built-in Domains

- **Topic** — general-purpose topic-based memories with lifecycle management
- **User** — user profile and preference tracking
- **Code Repo** — code repository knowledge (patterns, decisions, architecture)
- **Knowledge Base** — structured knowledge with classification
- **Log** — simple append-only logging

## Requirements

- Node.js 18+ or Bun
- A SurrealDB backend — either the embedded `@surrealdb/node` engine (default, via a `surrealkv://` connection string or one of the bundled connection adapters) or a running SurrealDB server reached over `ws://` / `http://`

## License

MIT
