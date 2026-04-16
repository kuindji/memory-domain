# path-memory-smoketest

A smoke-test for a multi-edge-type, bitemporal-light, multi-probe path-retrieval
architecture for agent memory.

Full design and rationale: `~/.claude/plans/swirling-churning-spindle.md`

## Hypothesis

Multi-edge-type path retrieval over a bitemporal-light claim store will produce
more coherent recall than flat vector search, and will narrow toward a coherent
arc across multi-turn queries.

The point of the smoke-test is to **disprove the hypothesis cheaply if it's
wrong**, before committing engineering effort.

## What it does

- Embeds claim sentences as nodes (no LLM)
- Builds a graph with three structural edge types (temporal / lexical / semantic)
- Stores claims with `valid_from` / `valid_until` (bitemporal-light); supersession
  invalidates an older claim without deleting it
- Retrieves by **multi-probe matching**: each query becomes a set of probe
  vectors; retrieval finds paths through the graph that touch multiple probes
  simultaneously, scored by probe-coverage + edge-type-diversity + recency
- Compares against a flat vector-search baseline (cosine over all claims) and a
  multi-turn iterative-arc convergence test

What it deliberately *doesn't* do (vs. Mem0/Zep/Graphiti/Cognee/GraphRAG):
no LLM in the memory layer, no entity extraction, no LLM-generated summaries,
no branch-merge. The retrieved path *is* the answer; the agent decides what to
do with it.

## Run

From the memory-domain repo root:

```bash
# Unit tests
bun test ./experiments/path-memory-smoketest/tests/store.test.ts
bun test ./experiments/path-memory-smoketest/tests/graph.test.ts
bun test ./experiments/path-memory-smoketest/tests/retriever.test.ts
bun test ./experiments/path-memory-smoketest/tests/embedder.test.ts

# Eval (A) — path retriever vs flat vector baseline
bun test ./experiments/path-memory-smoketest/tests/eval-vs-baseline.test.ts

# Eval (B) — multi-turn arc convergence
bun test ./experiments/path-memory-smoketest/tests/eval-iterative.test.ts

# Or all of the above
bun test ./experiments/path-memory-smoketest/tests/

# Typecheck
bunx tsc --noEmit -p experiments/path-memory-smoketest/tsconfig.json
```

The explicit `./` prefix is required because parent `bunfig.toml` restricts the
default test root to `./tests/`.

## Layout

```
src/        core implementation
  types.ts        Claim, Edge, HistoryEvent, Path, ScoredPath, RetrievalOptions
  store.ts        MemoryStore (bitemporal-light, history log, supersession)
  graph.ts        GraphIndex (temporal/lexical/semantic edges, IDF-weighted)
  tokenize.ts     stopword-filtered tokenizer (no NLP libs)
  retriever.ts    Multi-probe matcher with BFS (default) or Dijkstra traversal
  interfaces.ts   PathMemory facade + Session for iterative refinement
  embedder.ts     Factory wrapping parent's OnnxEmbeddingAdapter (cached)

data/
  tier1-alex.ts            ~38 hand-authored claims about Alex (career, family,
                           location, hobbies, with explicit supersessions)

eval/
  baseline.ts              Flat vector-search baseline
  queries-tier1.ts         12 hand-authored queries with marked ideal answer-claims
  conversation-traces-tier1.ts   3 multi-turn conversation traces

tests/
  *.test.ts       bun:test suites
  helpers.ts      fake/deterministic embedder + tokenize stub for unit tests
```

## Tier-1 results (post-Phase 1.5, defaults)

**Eval (A) — vs flat vector baseline (P/R @ K=|ideal|):**

```
Queries: 12    path wins: 3    baseline wins: 3    ties: 6
Mean F1 — path: 0.530    baseline: 0.507
```

BFS (default) stays at 0.530. Phase 1.5's weight-aware Dijkstra is
opt-in via `RetrievalOptions.traversal = "dijkstra"`; its best sweep
plateau is 0.510 (see `CONTEXT.md` § Phase 1.5 findings for the full
table). Phase 1's `pathQuality` / `lexicalIdfFloor` knobs remain
available but off by default.

Query-level highlights under BFS:

- **Path wins decisively on as-of queries** (e.g. "where alex lived in 2015"
  → F1 1.00 vs 0.00). Bitemporal-light primitive validates.
- **Path wins on multi-claim coverage queries** (hobbies, google work artifacts)
  — multi-probe matching surfaces related claims the baseline misses at K.
- **Baseline still wins on queries with strong literal cues** ("marriage
  and partner" natural query contains "Sam" + "marriage").

**Eval (B) — multi-turn arc convergence (BFS default):**

```
Arcs: 3    narrowed: 3    coherent (≥0.5): 2
```

- *family arc* — converges cleanly (date_sam, child_lily, met_sam at top across
  turns)
- *location arc (asOf)* — converges (loc_sf surfaces consistently)
- *career arc* — does NOT converge. Dijkstra doesn't fix this either:
  on tier-1 the primitive (probe composition + anchor selection) is the
  bottleneck, not the traversal algorithm.

## Hypothesis status

**Partially supported, post-Phase 1.5.** Architecture works end-to-end,
bitemporal-light validates, path retrieval beats baseline on specific
query shapes, but at tier-1 scale neither BFS nor weighted Dijkstra
dominates mean F1 at default weights. The length-penalty failure mode
is resolved; the lexical-edge-noise failure mode is *not* fixed by
weight-aware traversal alone — tier-1 is primitive-limited. Next
candidates: temporal-weight decay by `deltaT`, graph-informed anchor
re-selection, or moving to tier-2 (see `CONTEXT.md`).

## Out of scope (for follow-on work)

- Tiers 2 (Greek history) and 3 (Wikipedia) datasets
- Access tracking / well-worn-path index
- Agent profile knob (facts ↔ abstractions weighting)
- Context-building step that pre-summarizes a path for a downstream prompt
- Auto-tuning of scoring weights
- Heuristic supersession (currently supersession must be marked explicitly)
- Persistence — everything is in-memory, reconstructible from data files
