# Orama Search Integration — Test Config Design

**Date:** 2026-04-07
**Goal:** Add an Orama-powered search config to the KB architecture testing loop to evaluate whether Orama's BM25 ranking, field boosting, and faceted filtering improve context relevance and reduce noise compared to the current SurrealDB-based search.

## Context

The current `buildContext` pipeline calls `context.search()`, which routes through `SearchEngine` → SurrealDB (vector + BM25 + graph hybrid). Noise reduction configs (`noise-reduce-AC`, etc.) layer embedding reranking and tighter score thresholds on top, but the core retrieval is always SurrealDB.

Orama is an in-memory, TypeScript-native search engine with BM25, field boosting, and faceted filtering. It requires no server and can serialize to a file. This test evaluates whether replacing the SurrealDB search step with Orama improves retrieval quality.

## Scope

- Add Orama as a dependency
- Build an Orama index from KB entries after inbox processing
- Create a modified `buildContext` that queries Orama instead of `context.search()`
- Add new test config(s) to the architecture test matrix
- Measure with existing evaluation/scoring pipeline

**Not in scope:** Changing the inbox pipeline, storage layer, or any existing search code. Existing code is preserved (commented where bypassed).

## Architecture

### Integration point

`kb-domain.ts` → `buildContext()` → currently calls `context.search()`.

For the Orama config, `buildContext` calls an Orama search function instead. Everything downstream (validity filter, LLM rerank, parent resolution, dedup, budget, grouping) remains identical.

### Orama index schema

```typescript
{
  id: "string",           // memory ID (e.g., "memory:abc123")
  content: "string",      // entry text — primary BM25 search field
  classification: "enum", // fact | definition | how-to | reference | concept | insight
  topics: "string[]",     // topic labels from about_topic edges
  importance: "number",   // computed importance score (0-1)
  createdAt: "number",    // timestamp
  tokenCount: "number",   // for budget calculations
}
```

Domain attributes (`superseded`, `decomposed`, `validFrom`, `validUntil`, `parentMemoryId`, `confidence`) are stored alongside but not indexed — used for post-retrieval filtering (same as current pipeline).

### Orama search parameters

```typescript
{
  term: queryText,
  properties: ["content"],  // BM25 on content only
  boost: {
    // Boost definitions/concepts slightly — they tend to be higher quality
    classification: {
      definition: 1.3,
      concept: 1.2,
    }
  },
  limit: candidateCount,    // 3x budget to match current over-fetch ratio
}
```

The exact boost values are initial guesses — the tuning loop can optimize them later.

### Data flow

```
Phase 2 (Process) completes
    ↓
Phase 2.5: Build Orama Index
    - Read all KB-owned memories + attributes from SurrealDB
    - Filter out superseded/decomposed entries
    - Build Orama index in memory
    - Serialize index to checkpoint file
    ↓
Phase 4 (Evaluate)
    - Engine uses modified KB domain with Orama buildContext
    - buildContext loads serialized Orama index
    - Queries Orama instead of context.search()
    - Rest of pipeline unchanged
    ↓
Phase 5 (Score) — unchanged
```

### Files to create

1. **`tests-integration/kb-architecture/orama-index.ts`**
   - `buildOramaIndex(engine: MemoryEngine): Promise<OramaIndex>` — reads all KB entries from SurrealDB, builds and returns Orama index
   - `serializeOramaIndex(index, configName): void` — writes to checkpoint
   - `loadOramaIndex(configName): OramaIndex` — reads from checkpoint
   - `searchOrama(index, query, limit): ScoredMemory[]` — queries index, maps results to `ScoredMemory` shape

2. **`tests-integration/kb-architecture/orama-kb-domain.ts`**
   - `createOramaKbDomain(oramaIndex): DomainConfig` — returns a KB domain config where `buildContext` uses Orama search instead of `context.search()`. The original search code is preserved as comments.

### Files to modify

3. **`tests-integration/kb-architecture/configs.ts`**
   - Add `orama-bm25` config with `useOrama: true` flag

4. **`tests-integration/kb-architecture/types.ts`**
   - Add `useOrama?: boolean` to `ArchitectureConfig`

5. **`tests-integration/kb-architecture/engine-factory.ts`**
   - When `config.useOrama` is true, use `createOramaKbDomain` instead of stock KB domain

6. **`tests-integration/kb-architecture/run.ts`**
   - After Phase 2, if config has `useOrama`, build and serialize Orama index
   - Pass index reference to engine factory

### ScoredMemory mapping

Orama returns `{ id, score, document }`. Map to `ScoredMemory`:

```typescript
{
  id: document.id,
  content: document.content,
  score: hit.score,          // Orama's BM25 score (normalized)
  scores: { fulltext: hit.score },
  tags: [KB_TAG],
  domainAttributes: {
    [KB_DOMAIN_ID]: {
      classification: document.classification,
      importance: document.importance,
      // ... other attrs from stored data
    }
  },
  eventTime: null,
  createdAt: document.createdAt,
  tokenCount: document.tokenCount,
}
```

### Test configs to add

**`orama-bm25`** — Orama BM25 search, no embedding rerank, standard pipeline:
```typescript
{
  name: "orama-bm25",
  pipeline: NO_SUPERSESSION_PIPELINE,  // classify + tag + topic (matches noise-reduce configs)
  search: HYBRID_DEFAULT,               // ignored when useOrama=true, kept for type compat
  consolidate: false,
  contextBudget: 2000,
  useOrama: true,
}
```

This directly compares against `noise-reduce-AC` (current best non-LLM-rerank config) since both use the same pipeline stages and budget.

## What we're measuring

Same metrics as all existing configs:

| Metric | What it tells us |
|--------|-----------------|
| `avgScore` | Answer quality (0-5, LLM-graded) |
| `contextRelevance` | % of required entries found in context |
| `contextNoise` | % of returned entries that weren't required |
| `supersessionAccuracy` | % of questions where superseded entries were correctly excluded |
| `avgTime` | buildContext + ask latency |

**Success criteria:** `contextNoise` lower than `noise-reduce-AC` without significant drop in `contextRelevance` or `avgScore`.

## Dependencies

- `@orama/orama` npm package (MIT license, zero native deps, TypeScript-native)
