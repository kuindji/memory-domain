# Memory Domain — Architecture Overview

A graph-backed memory engine where **domains** own, process, and query memories independently while sharing a unified data layer.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Memory** | A text entry with metadata (timestamps, token count, optional embedding). Stored as a `memory` node in SurrealDB. |
| **Domain** | A bounded area of concern that owns memories and defines how they are processed, searched, and scheduled. Implements `DomainConfig`. |
| **Tag** | A hierarchical label attached to memories via `tagged` edges. Tags form trees through `child_of` edges. Supports recursive subtree traversal. |
| **Ownership** | A many-to-many relationship between memories and domains via `owned_by` edges. A memory exists as long as at least one domain owns it (ref-counted deletion). |

## Graph Data Model

```
memory ──tagged──► tag ──child_of──► tag
  │
  ├──owned_by──► domain
  │
  ├──reinforces──► memory
  ├──contradicts──► memory
  ├──summarizes──► memory
  └──refines──► memory

tag ──has_rule──► domain

meta (key-value store for domain state)
```

Domains can extend the graph with custom node and edge types via `DomainSchema`. Shared node types (e.g., `person`, `region`) are defined by registering a domain with a schema — other domains can then reference and extend those types. Node and edge names are validated as safe identifiers on registration.

## Component Architecture

```
┌─────────────────────────────────────────────────┐
│                  MemoryEngine                    │
│                                                  │
│  Orchestrates all subsystems. Public API:        │
│  registerDomain, ingest, search, buildContext,   │
│  ask, releaseOwnership, processInbox             │
├──────────┬──────────┬──────────┬────────────────┤
│  Schema  │  Domain  │  Inbox   │   Scheduler    │
│ Registry │ Registry │Processor │                │
├──────────┴──────────┴──────────┴────────────────┤
│              SearchEngine                        │
│  (vector / fulltext / graph / hybrid)            │
│  (+ post-search enrichment)                      │
├─────────────────────────────────────────────────┤
│              GraphStore                          │
├─────────────────────────────────────────────────┤
│              SurrealDB                           │
└─────────────────────────────────────────────────┘
```

### Components

**`MemoryEngine`** (`src/core/engine.ts`)
Entry point. Initializes all subsystems, connects to SurrealDB, registers the built-in `log` domain, and exposes the public API. Creates `DomainContext` instances that give domains scoped access to the graph. Stores the optional `EmbeddingAdapter` and `RepetitionConfig` for vector search and deduplication.

**`DomainRegistry`** (`src/core/domain-registry.ts`)
In-memory registry of `DomainConfig` instances. Lookup by ID, listing, registration/unregistration. The `log` domain is protected from unregistration.

**`SchemaRegistry`** (`src/core/schema-registry.ts`)
Manages SurrealDB table definitions. Handles two layers:
- **Core schema** — `memory`, `tag`, `domain`, `meta` tables and built-in edges. Conditionally defines an HNSW vector index on `memory.embedding` when an embedding adapter is configured.
- **Domain schemas** — Domain-defined node and edge types. Multiple domains can reference the same node type; the registry merges fields and detects type conflicts. Validates identifier names on registration. Exposes `getRegisteredEdgeNames()` for cleanup operations.

**`SearchEngine`** (`src/core/search-engine.ts`)
Multi-mode search with four strategies:
- **Vector** — Cosine similarity search on embeddings via `vector::similarity::cosine()`. Requires an `EmbeddingAdapter`. Gracefully returns empty results when no adapter is configured (vector weight auto-zeroed).
- **Fulltext** — BM25 with CONTAINS keyword fallback
- **Graph** — Tag-based filtering, edge traversal, and recency fallback
- **Hybrid** — Runs all three in parallel via `Promise.all`, merges candidates, computes weighted scores

Default mode and weights are configurable via `EngineConfig.search`. After scoring/filtering/budgeting, results are enriched with `connections` (reference edges) and `domainAttributes` (ownership metadata) via batch queries.

**`InboxProcessor`** (`src/core/inbox-processor.ts`)
Polls for memories tagged with `inbox`, finds their owning domains via `owned_by` edges, and calls each domain's `processInboxItem()`. Removes the inbox tag after processing. Runs on a configurable interval with batch limits.

**`Scheduler`** (`src/core/scheduler.ts`)
Manages periodic tasks defined by domains via `DomainSchedule`. Each schedule has an interval and a `run()` function that receives a `DomainContext`. Ticks on a configurable interval (default 60s).

**`GraphStore`** (`src/core/graph-store.ts`)
Thin wrapper over SurrealDB providing typed CRUD operations: `createNode`, `getNode`, `updateNode`, `deleteNode`, `relate`, `unrelate`, `traverse`, `query`, `transaction`.

**`EventEmitter`** (`src/core/events.ts`)
Simple pub/sub for system events: `ingested`, `deleted`, `reinforced`, `tagAssigned`, `tagRemoved`, `ownershipAdded`, `ownershipRemoved`, `inboxProcessed`, `scheduleRun`, `error`, `warning`.

## Domain Lifecycle

```
1. registerDomain(config)
   ├── Register schema extensions (if any; names validated)
   ├── Create domain node in graph (domain:<id>)
   ├── Add to DomainRegistry
   └── Register schedules (if any)

2. ingest(text, { domains: [...] })
   ├── Count tokens
   ├── Generate embedding (if adapter configured)
   ├── Dedup check (if embedding + repetition config + !skipDedup)
   │     ├── similarity >= duplicateThreshold → skip (no node created)
   │     └── similarity >= reinforceThreshold → store + reinforces edge
   ├── Create memory node (with embedding if available)
   ├── Tag with inbox + any extra tags
   └── Create owned_by edges to target domains (log always included)

3. processInbox()  (called by InboxProcessor on interval)
   ├── Find oldest inbox-tagged memory
   ├── Look up owning domains via owned_by edges
   ├── For each domain: call processInboxItem(entry, context)
   └── Remove inbox tag

4. search(query) / buildContext(text) / ask(question)
   ├── Domains can expand queries (search.expand)
   ├── SearchEngine executes across modes (vector/fulltext/graph/hybrid)
   ├── Filter by domain ownership, minScore, limit, tokenBudget
   ├── Enrich results with connections and domainAttributes
   └── Domains can rank results (search.rank)

5. releaseOwnership(memoryId, domainId)
   ├── Remove owned_by edge
   └── If no owners remain → delete memory, core edges, and domain-defined edges
```

## Public API

### MemoryEngine

#### Lifecycle

```ts
initialize(config: EngineConfig): Promise<void>
```
Connect to SurrealDB, register core schema (with HNSW index if `config.embedding` provided), wire up all subsystems, register built-in `log` domain.

```ts
close(): Promise<void>
```
Stop all background processing and close the database connection.

#### Domain Management

```ts
registerDomain(domain: DomainConfig): Promise<void>
```
Register a domain with optional schema, inbox handler, search hooks, and schedules. Creates a `domain:<id>` node in the graph.

#### Ingestion

```ts
ingest(text: string, options?: IngestOptions): Promise<IngestResult>
```
Store a text memory. If an `EmbeddingAdapter` and `RepetitionConfig` are configured (and `skipDedup` is not set), checks for duplicates via cosine similarity before storing:
- `duplicateThreshold` or above: returns `{ action: 'skipped', existingId }`
- `reinforceThreshold` or above: stores the memory, creates a `reinforces` edge, returns `{ action: 'reinforced', id, existingId }`
- Below both: stores normally, returns `{ action: 'stored', id }`

Without an embedding adapter, always stores.

| IngestOptions field | Description |
|---------------------|-------------|
| `domains?` | Target domains (log always included). Omit for all registered domains. |
| `tags?` | Tags to assign on ingest (in addition to inbox). |
| `eventTime?` | When the described event happened (vs. ingestion time). |
| `metadata?` | Attributes stored on the `owned_by` edges. |
| `skipDedup?` | Skip deduplication even if configured. |

#### Search & Retrieval

```ts
search(query: SearchQuery): Promise<SearchResult>
```
Execute a search across memory. Supports four modes: `vector`, `fulltext`, `graph`, `hybrid` (default from config, fallback `hybrid`). Domains can expand queries and rank results. Results include `connections.references` (linked memories via reinforces/contradicts/summarizes/refines) and `domainAttributes` (ownership metadata per domain).

| SearchQuery field | Description |
|-------------------|-------------|
| `text?` | Search text for fulltext/vector modes. |
| `mode?` | `'vector'` \| `'fulltext'` \| `'graph'` \| `'hybrid'`. Defaults to config or `'hybrid'`. |
| `tags?` | Filter by tag labels. |
| `domains?` | Filter by domain ownership. |
| `ids?` | Filter to specific memory IDs. |
| `attributes?` | Filter by ownership attributes. |
| `since?` | Filter by timestamp. |
| `limit?` | Max results (default 20). |
| `tokenBudget?` | Greedy token budget cap. |
| `minScore?` | Minimum score threshold. |
| `weights?` | `{ vector?, fulltext?, graph? }` — override default weights. |
| `traversal?` | `{ from, pattern, depth? }` — graph traversal specification. |

```ts
buildContext(text: string, options?: ContextOptions): Promise<ContextResult>
```
Build a formatted context string from relevant memories. If a single domain is targeted and it implements `buildContext`, delegates entirely to that domain. Otherwise runs a hybrid search with the configured defaults, applies a token budget (default 4000), and formats results as numbered entries: `[1] content\n\n[2] content...`.

| ContextOptions field | Description |
|----------------------|-------------|
| `domains?` | Scope to specific domains. |
| `budgetTokens?` | Token budget (default 4000). |
| `maxMemories?` | Max memories to consider (default 50). |

```ts
ask(question: string, options?: AskOptions): Promise<AskResult>
```
Multi-round LLM-driven question answering. The LLM generates search queries iteratively (up to 3 rounds), accumulates unique memories, then synthesizes a final answer grounded in retrieved evidence. Requires `llm.generate()` and `llm.synthesize()`.

| AskOptions field | Description |
|------------------|-------------|
| `domains?` | Scope to specific domains. |
| `tags?` | Constrain to tags. |
| `budgetTokens?` | Token budget for accumulated memories (default 8000). |
| `limit?` | Max results per search round (default 30). |

#### Ownership

```ts
releaseOwnership(memoryId: string, domainId: string): Promise<void>
```
Remove a domain's ownership of a memory. If no owners remain, the memory and all its edges (core and domain-defined) are deleted.

#### Background Processing

```ts
startProcessing(intervalMs?: number): void
```
Start the inbox processor and scheduler for background operations.

```ts
stopProcessing(): void
```
Stop all background processing.

```ts
processInbox(): Promise<boolean>
```
Manually process one inbox item. Returns `true` if an item was processed.

#### Accessors

```ts
getGraph(): GraphStore         // Direct graph access
getDomainRegistry(): DomainRegistry  // Domain lookup
getEvents(): EventEmitter      // Subscribe to events
```

### DomainContext

Scoped context passed to domain handlers (`processInboxItem`, scheduled tasks). Operations are bound to the owning domain.

| Method | Signature | Purpose |
|--------|-----------|---------|
| `getMemory` | `(id: string) => Promise<MemoryEntry \| null>` | Fetch a single memory |
| `getMemories` | `(filter?: MemoryFilter) => Promise<MemoryEntry[]>` | Query memories by filter |
| `addTag` | `(path: string) => Promise<void>` | Create hierarchical tag path (`a/b/c`) |
| `tagMemory` | `(memoryId, tagId) => Promise<void>` | Assign a tag to a memory |
| `untagMemory` | `(memoryId, tagId) => Promise<void>` | Remove a tag from a memory |
| `getTagDescendants` | `(tagPath: string) => Promise<string[]>` | Recursive subtree traversal (up to 10 levels) |
| `addOwnership` | `(memoryId, domainId, attrs?) => Promise<void>` | Share a memory with another domain |
| `releaseOwnership` | `(memoryId, domainId) => Promise<void>` | Release ownership (cascade deletes if last) |
| `updateAttributes` | `(memoryId, attrs) => Promise<void>` | Update ownership edge attributes |
| `search` | `(query) => Promise<SearchResult>` | Search scoped to this domain |
| `getMeta` / `setMeta` | `(key) / (key, value)` | Per-domain persistent key-value store |
| `graph` | `GraphApi` | Direct SurrealDB graph access |
| `llm` | `LLMAdapter` | LLM operations |

### Configuration

```ts
interface EngineConfig {
  connection: string              // "mem://", "file:///path", "ws://host:port"
  namespace?: string              // default: "default"
  database?: string               // default: "memory"
  credentials?: { user: string; pass: string }
  llm: LLMAdapter                // Required — LLM operations
  embedding?: EmbeddingAdapter    // Optional — enables vector search + dedup
  repetition?: RepetitionConfig   // Optional — dedup thresholds
  search?: {                      // Optional — search defaults
    defaultMode?: 'vector' | 'fulltext' | 'hybrid'
    defaultWeights?: { vector?: number; fulltext?: number; graph?: number }
    defaultEf?: number
  }
}
```

### Adapter Interfaces

**`LLMAdapter`** — All methods except `extract` and `consolidate` are optional. Features requiring specific methods throw if the method is missing.

| Method | Signature | Used By |
|--------|-----------|---------|
| `extract` | `(text, prompt?) => Promise<string[]>` | Domain inbox processing |
| `extractStructured?` | `(text, schema, prompt?) => Promise<unknown[]>` | Domain inbox processing |
| `consolidate` | `(memories: string[]) => Promise<string>` | Domain processing |
| `assess?` | `(content, existing[]) => Promise<number>` | Novelty scoring (0-1) |
| `rerank?` | `(query, candidates[]) => Promise<string[]>` | Domain search.rank |
| `synthesize?` | `(query, memories[]) => Promise<string>` | `ask()` final step |
| `generate?` | `(prompt) => Promise<string>` | `ask()` query planning |

**`EmbeddingAdapter`** — Enables vector search and deduplication.

| Member | Signature | Purpose |
|--------|-----------|---------|
| `embed` | `(text: string) => Promise<number[]>` | Generate embedding vector |
| `embedBatch` | `(texts: string[]) => Promise<number[][]>` | Batch embedding |
| `dimension` | `readonly number` | Vector dimensionality (used for HNSW index) |

### DomainConfig

```ts
interface DomainConfig {
  id: string
  name: string
  schema?: DomainSchema                    // Custom graph extensions
  processInboxItem(entry, context): Promise<void>  // Required handler
  search?: {
    rank?(query, candidates): ScoredMemory[]       // Re-rank results
    expand?(query, context): Promise<SearchQuery>   // Rewrite queries
  }
  buildContext?(text, budget, context): Promise<ContextResult>  // Custom context building
  describe?(): string                      // Domain description
  schedules?: DomainSchedule[]             // Periodic tasks
}
```

### Event System

| Event | Payload | When |
|-------|---------|------|
| `ingested` | `{ id, content, tokenCount }` | After successful ingest |
| `deleted` | `{ memoryId }` | After cascade delete (no owners) |
| `reinforced` | `{ id, existingId, similarity }` | After dedup reinforcement |
| `tagAssigned` | `{ memoryId, tagId }` | `DomainContext.tagMemory()` |
| `tagRemoved` | `{ memoryId, tagId }` | `DomainContext.untagMemory()` |
| `ownershipAdded` | `{ memoryId, domainId }` | `DomainContext.addOwnership()` |
| `ownershipRemoved` | `{ memoryId, domainId }` | `releaseOwnership()` |
| `inboxProcessed` | `{ memoryId }` | After inbox item processed |
| `scheduleRun` | `{ domainId, scheduleId }` | After scheduled task runs |
| `error` | `{ error }` | Subsystem errors |
| `warning` | `{ message }` | Non-fatal issues |

## Built-in Domain

**`logDomain`** (`src/domains/log-domain.ts`) — No-op processor that keeps all ingested memories as a chronological log. Always receives ownership. Cannot be unregistered.

## Directory Structure

```
src/
  core/
    engine.ts            # MemoryEngine — main orchestrator
    domain-registry.ts   # Domain registration and lookup
    schema-registry.ts   # SurrealDB schema management
    search-engine.ts     # Multi-mode search + result enrichment
    inbox-processor.ts   # Inbox polling and domain dispatch
    scheduler.ts         # Periodic domain tasks
    graph-store.ts       # SurrealDB graph operations
    scoring.ts           # Token counting and score merging
    events.ts            # Event emitter
    types.ts             # All type definitions
  domains/
    log-domain.ts        # Built-in log domain
  adapters/
    llm/
      claude-cli.ts      # Claude CLI LLM adapter
tests/
  ingestion.test.ts      # Ingest, ownership, ref-counted deletion, dedup
  inbox-processor.test.ts # Inbox processing pipeline
  search-engine.test.ts  # Search modes, domain filtering, enrichment
  vector-search.test.ts  # Embedding and vector search
  tag-traversal.test.ts  # Recursive tag subtree traversal
  schema-registry.test.ts # Schema registration and conflicts
  multi-domain.test.ts   # Multi-domain integration
  build-context.test.ts  # Context building
  ask.test.ts            # Multi-round LLM query
  graph-store.test.ts    # Graph CRUD operations
  scoring.test.ts        # Token counting and score merging
  events.test.ts         # Event emission
  domain-registry.test.ts # Domain registration
  scheduler.test.ts      # Scheduled tasks
  helpers.ts             # Test utilities (MockLLMAdapter, MockEmbeddingAdapter)
```

## Runtime Dependencies

- **SurrealDB**: `surrealdb@^2.0.0` + `@surrealdb/node@^3.0.0`
- **js-tiktoken**: Token counting (gpt-4o encoder, lazy singleton)
- **Claude CLI**: `claude --print` subprocess for all LLM calls (via `Bun.spawn`)
- **Bun runtime**: Required (`Bun.spawn`, `bun:test`)
