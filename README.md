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

`OnnxEmbeddingAdapter` needs the all-MiniLM-L6-v2 ONNX model (~86 MB) and its vocab file. Fetch them with:

```bash
npx memory-domain-download-model
# or to a custom location:
npx memory-domain-download-model --dir ./my-models
```

By default this writes to `./.memory-domain/model/` relative to the current directory, which is where `new OnnxEmbeddingAdapter()` looks. If you download elsewhere, pass the same path to the adapter via `new OnnxEmbeddingAdapter({ modelDir: "./my-models" })`.

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
