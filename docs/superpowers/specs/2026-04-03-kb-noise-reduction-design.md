# KB Context Noise Reduction

**Goal:** Reduce context noise from ~90% to <20% while maintaining answer quality >4.5/5.

**Current state:** The `no-supersession-hybrid-noconsolidate-2000` config scores 4.57/5 but has 90% context noise -- most retrieved memories are irrelevant to the query.

**Strategy:** Three approaches tested individually and in combinations, stopping when targets are met.

**Tech Stack:** TypeScript, SurrealDB, ONNX embeddings, Claude CLI (haiku), bun

---

## Root Cause Analysis

The 90% noise compounds across multiple stages:

1. **Graph recency fallback** (`search-engine.ts:296-321`) -- when graph search has no tags/traversal, returns 20 most recent memories at score 0.5, all passing minScore
2. **Low minScore threshold** (0.3) -- lets any vague keyword match through
3. **High search limits** (20 per mode x 6 searches = 120 candidate slots) -- too many candidates relative to what's relevant
4. **Ineffective topic penalty** (0.5x) -- halves scores but doesn't filter; a 0.6 score becomes 0.3, still passing threshold
5. **No precision pass** -- candidates are ranked but never verified for actual relevance

---

## Approach A: Tighten Existing Filters

Four changes to existing code, zero new dependencies or API calls.

### A1. Remove graph recency fallback

**File:** `src/core/search-engine.ts:296-321`

The recency fallback returns 20 random recent memories at score 0.5 whenever graph search has no tags and no traversal. In the KB context, buildContext always passes tags, so the fallback is only triggered when the graph mode runs as part of hybrid search without tags propagated. Return an empty map instead.

### A2. Raise minScore default to 0.5

**File:** `src/domains/kb/kb-domain.ts:161`

Change the tunable param default from 0.3 to 0.5. Update the param definition range: min from 0.05 to 0.15 (anything below is meaningless). This filters out weak matches that have incidental keyword overlap.

### A3. Reduce search limit from 20 to 10

**File:** `src/core/search-engine.ts` -- vectorSearch, fulltextSearch, graphSearch default limits

Each search mode defaults to `query.limit ?? 20`. Change to `query.limit ?? 10`. With 6 tag-filtered searches in buildContext (3 sections x 2 tags), this reduces the candidate pool from 120 to 60 slots maximum.

### A4. Hard topic filter with fallback

**File:** `src/domains/kb/kb-domain.ts` -- `applyTopicBoost` function

When topics are identified for a query, non-topic memories are currently penalized (score x 0.5) but not removed. Change behavior: if topics are found, remove all non-topic memories entirely. Exception: if removing them would leave zero memories, keep the top-scoring non-topic memory as fallback.

---

## Approach C: Embedding Re-ranking

A second-pass precision filter using direct embedding similarity after the search pipeline.

### Implementation

**File:** `src/core/search-engine.ts` -- new `rerankByEmbedding` method

After the normal search pipeline (hybrid search + tag filter + minScore + sort), apply a re-ranking step:

1. Compute query embedding (reuse from vector search if available, otherwise compute once)
2. For each candidate in the result set, fetch its stored embedding from the `memory` table
3. Compute cosine similarity between query embedding and each candidate embedding
4. Apply a re-rank threshold (default 0.5) -- drop candidates below
5. Re-sort by direct cosine similarity

**Activation:** Add a `rerank?: boolean` field to `SearchQuery`. The KB domain's buildContext passes `rerank: true` on each search call when approach C is active.

**Why this differs from vector search:** Vector search returns top-20 globally, then tag filtering removes many good matches and keeps mediocre-scoring ones that happen to have the right tag. Re-ranking is a precision pass on the post-filter set -- it catches cases where a memory passed tag + minScore but is actually irrelevant.

**Cost:** One DB query per search call to fetch embeddings (batch SELECT), plus in-memory cosine computation. No LLM calls. The embedding adapter's `embed()` for the query is called once per buildContext (cached across sections).

### Types

Add to `SearchQuery`:
```typescript
rerank?: boolean;
rerankThreshold?: number;  // default 0.5
```

### Embedding cache

The SearchEngine already creates the query embedding in vectorSearch. Extract it to a short-lived cache (per-search-call) so rerankByEmbedding doesn't recompute it.

---

## Approach B: LLM Re-ranking

Use a fast LLM to semantically score each candidate's relevance to the query.

### Implementation

**File:** `src/domains/kb/kb-domain.ts` -- new step in buildContext between search and token budget

After all section searches are complete but before `truncateToTokenBudget`:

1. Collect all candidate memories across sections
2. Send a single LLM prompt: "Given query: X. Score each memory 0-5 for relevance." with all candidate contents
3. Parse scores, drop anything below 3
4. Re-sort by LLM relevance score
5. Then apply token budget truncation on the filtered set

**Activation:** Add a `llmRerank?: boolean` field to the KB domain's buildContext options (passed through DomainContext or as a tunable param).

**Cost:** One LLM call per buildContext invocation. Using haiku for speed. Prompt size is bounded by the number of candidates (typically 10-30 after approach A/C filtering).

**Fallback:** If LLM call fails, skip re-ranking and proceed with existing results.

---

## Testing Matrix

All tests run on the `no-supersession-hybrid-noconsolidate-2000` config with the expanded 65-entry, 23-question dataset.

| Step | Config | Stop if |
|------|--------|---------|
| 1 | A only | noise <20% AND quality >4.5 |
| 2 | C only | noise <20% AND quality >4.5 |
| 3 | A+C | noise <20% AND quality >4.5 |
| 4 | A+B | noise <20% AND quality >4.5 |
| 5 | C+B | noise <20% AND quality >4.5 |
| 6 | A+B+C | noise <20% AND quality >4.5 |

Each step uses the existing architecture testing loop infrastructure (phases 4-5) for evaluation and scoring.

### New configs to add

Add to `configs.ts`:
```
noise-reduce-A
noise-reduce-C
noise-reduce-AC
noise-reduce-AB
noise-reduce-CB
noise-reduce-ABC
```

Each config specifies which approaches are active via new fields on `ArchitectureConfig`:
```typescript
noiseReduction?: {
    tightenFilters?: boolean;    // Approach A
    embeddingRerank?: boolean;   // Approach C
    llmRerank?: boolean;         // Approach B
};
```

---

## File Structure

### Approach A (modify only)
- `src/core/search-engine.ts` -- remove recency fallback, reduce default limits
- `src/domains/kb/kb-domain.ts` -- raise minScore, hard topic filter

### Approach C (modify only)
- `src/core/search-engine.ts` -- add `rerankByEmbedding` method, embedding cache
- `src/core/types.ts` -- add `rerank`, `rerankThreshold` to SearchQuery
- `src/domains/kb/kb-domain.ts` -- pass rerank option in buildContext searches

### Approach B (modify only)
- `src/domains/kb/kb-domain.ts` -- add LLM re-ranking step in buildContext

### Testing infrastructure
- `tests-integration/kb-architecture/configs.ts` -- add 6 noise reduction configs
- `tests-integration/kb-architecture/types.ts` -- add `noiseReduction` to ArchitectureConfig

---

## Success Criteria

- Context noise <20% (from ~90%)
- Answer quality >4.5/5 (from 4.57/5 -- must not regress)
- No new external dependencies
- Changes are backward-compatible (existing configs work unchanged)

## Risks

- **Quality regression from aggressive filtering:** Hard topic filter (A4) or high minScore (A2) may drop relevant memories. Mitigated by fallback logic and by testing quality alongside noise.
- **Embedding re-rank redundancy:** Vector search already uses embeddings, so approach C may add little over approach A. Testing will reveal.
- **LLM scoring noise:** Same +-0.3 non-determinism from previous testing. Single run per config; accept noise in results.
