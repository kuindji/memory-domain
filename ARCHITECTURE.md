# Active Memory — Architecture Overview

A graph-backed memory engine where **domains** own, process, and query memories independently while sharing a unified data layer.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Memory** | A text entry with metadata (timestamps, token count, optional embedding). Stored as a `memory` node in SurrealDB. |
| **Domain** | A bounded area of concern that owns memories and defines how they are processed, searched, and scheduled. Implements `DomainConfig`. |
| **Tag** | A hierarchical label attached to memories via `tagged` edges. Tags form trees through `child_of` edges. |
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

Domains can extend the graph with custom node and edge types via `DomainSchema`. Shared node types (e.g., `person`, `region`) are defined by registering a domain with a schema — other domains can then reference and extend those types. This keeps composability uniform: everything is a domain.

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
├─────────────────────────────────────────────────┤
│              GraphStore                          │
├─────────────────────────────────────────────────┤
│              SurrealDB                           │
└─────────────────────────────────────────────────┘
```

### Components

**`MemoryEngine`** (`src/core/engine.ts`)
Entry point. Initializes all subsystems, connects to SurrealDB, registers the built-in `log` domain, and exposes the public API. Creates `DomainContext` instances that give domains scoped access to the graph.

**`DomainRegistry`** (`src/core/domain-registry.ts`)
In-memory registry of `DomainConfig` instances. Lookup by ID, listing, registration/unregistration. The `log` domain is protected from unregistration.

**`SchemaRegistry`** (`src/core/schema-registry.ts`)
Manages SurrealDB table definitions. Handles two layers:
- **Core schema** — `memory`, `tag`, `domain`, `meta` tables and built-in edges
- **Domain schemas** — Domain-defined node and edge types. Multiple domains can reference the same node type; the registry merges fields and detects type conflicts.

**`SearchEngine`** (`src/core/search-engine.ts`)
Multi-mode search with four strategies:
- **Vector** — KNN search on embeddings (placeholder, requires embedding model)
- **Fulltext** — BM25 with CONTAINS fallback
- **Graph** — Tag-based filtering and edge traversal
- **Hybrid** — Combines all three with configurable weights

Results are filtered by domain ownership when `domains` is specified. Supports token budgets and minimum score thresholds.

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
   ├── Register schema extensions (if any)
   ├── Create domain node in graph (domain:<id>)
   ├── Add to DomainRegistry
   └── Register schedules (if any)

2. ingest(text, { domains: [...] })
   ├── Create memory node
   ├── Tag with inbox + any extra tags
   └── Create owned_by edges to target domains (log always included)

3. processInbox()  (called by InboxProcessor on interval)
   ├── Find oldest inbox-tagged memory
   ├── Look up owning domains via owned_by edges
   ├── For each domain: call processInboxItem(entry, context)
   └── Remove inbox tag

4. search(query) / buildContext(text) / ask(question)
   ├── Domains can expand queries (search.expand)
   ├── SearchEngine executes across modes
   ├── Filter by domain ownership
   └── Domains can rank results (search.rank)

5. releaseOwnership(memoryId, domainId)
   ├── Remove owned_by edge
   └── If no owners remain → delete memory and all its edges
```

## DomainContext

When a domain processes items or runs schedules, it receives a `DomainContext` providing scoped operations:

| Method | Purpose |
|--------|---------|
| `getMemory(id)` | Read a single memory entry by ID |
| `getMemories(options?)` | Query memories by filter (ids, domain, since) |
| `addTag` / `tagMemory` / `untagMemory` | Manage tags and tag hierarchies |
| `getTagDescendants` | Walk the tag tree |
| `addOwnership` / `releaseOwnership` | Transfer memories between domains |
| `updateAttributes` | Update ownership edge attributes |
| `search` | Search scoped to the current domain |
| `getMeta` / `setMeta` | Persistent key-value state per domain |
| `graph` | Direct graph access for custom node/edge operations |
| `llm` | LLM adapter for extraction, consolidation, synthesis |

## Built-in Domain

**`logDomain`** (`src/domains/log-domain.ts`) — No-op processor that keeps all ingested memories as a chronological log. Always receives ownership. Cannot be unregistered.

## Adapters

**`LLMAdapter`** — Interface for LLM operations: `extract`, `consolidate`, `assess`, `rerank`, `synthesize`, `generate`. Required methods vary by feature (`ask` needs `generate` + `synthesize`).

**`ClaudeCliAdapter`** (`src/adapters/llm/claude-cli.ts`) — Implementation using Claude CLI.

## Directory Structure

```
src/
  core/
    engine.ts            # MemoryEngine — main orchestrator
    domain-registry.ts   # Domain registration and lookup
    schema-registry.ts   # SurrealDB schema management
    search-engine.ts     # Multi-mode search
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
  ingestion.test.ts      # Ingest, ownership, ref-counted deletion
  inbox-processor.test.ts # Inbox processing pipeline
  search-engine.test.ts  # Search modes and domain filtering
  schema-registry.test.ts # Schema registration and conflicts
  multi-domain.test.ts   # Multi-domain integration
  graph-store.test.ts    # Graph CRUD operations
  helpers.ts             # Test utilities
```
