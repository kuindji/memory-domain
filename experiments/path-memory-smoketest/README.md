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
  graph.ts        GraphIndex (temporal/lexical/semantic edges, BFS-friendly)
  tokenize.ts     stopword-filtered tokenizer (no NLP libs)
  retriever.ts    Multi-probe matcher: anchors → bounded BFS → scored paths
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

## Tier-1 results (last run, defaults)

**Eval (A) — vs flat vector baseline (P/R @ K=|ideal|):**

```
Queries: 12    path wins: 3    baseline wins: 3    ties: 6
Mean F1 — path: 0.530    baseline: 0.507
```

The path retriever marginally edges out flat vector search on average F1, with
an even win/loss split. Notable observations:

- **Path wins decisively on as-of queries** (e.g. "where alex lived in 2015"
  → F1 1.00 vs 0.00). Bitemporal-light primitive validates.
- **Path wins on multi-claim coverage queries** (hobbies, google work artifacts)
  — multi-probe matching surfaces related claims the baseline misses at K.
- **Baseline wins on queries with strong literal cues** ("marriage and partner"
  natural query contains "Sam" + "marriage" — direct cosine hits are excellent).
  This exposes a real failure mode: lexical edges on ubiquitous tokens like
  "alex" pull noisy claims into paths.

**Eval (B) — multi-turn arc convergence:**

```
Arcs: 3    narrowed: 3    coherent (≥0.5): 2
```

- *family arc* — converges cleanly (date_sam, child_lily, met_sam at top across
  turns)
- *location arc (asOf)* — converges (loc_sf surfaces consistently)
- *career arc* — does NOT converge cleanly. Accumulating probes across the full
  arc pulls in noise via lexical edges on "Alex" — the system loses topical
  focus. Real failure mode worth investigating in tier 2.

## Hypothesis status

**Partially supported.** The architecture works end-to-end, surfaces sensible
results, validates the bitemporal-light primitive on as-of queries, and beats
flat vector search on a subset of queries — but does not dominate baseline at
default weights. Two clear failure modes surfaced:

1. **Lexical edge noise from ubiquitous tokens** (a single common token pulls
   topically-unrelated claims into paths). Likely fix: IDF-weighted lexical
   edges, or a min-jaccard threshold above 0.
2. **Length penalty trades off against multi-anchor traversal**. Default
   weights make solo anchor paths competitive with multi-anchor paths.
   Likely fix: scale length penalty by *informational* length (claims added)
   not raw hop count.

Both are tuning issues, not architectural ones — appropriate findings for a
smoke-test at this scope.

## Out of scope (for follow-on work)

- Tiers 2 (Greek history) and 3 (Wikipedia) datasets
- Access tracking / well-worn-path index
- Agent profile knob (facts ↔ abstractions weighting)
- Context-building step that pre-summarizes a path for a downstream prompt
- IDF-weighted lexical edges
- Auto-tuning of scoring weights
- Heuristic supersession (currently supersession must be marked explicitly)
- Persistence — everything is in-memory, reconstructible from data files
