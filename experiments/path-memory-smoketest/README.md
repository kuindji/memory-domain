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

## Tier-2 results (Phase 2)

Greek-history corpus: 242 claims across 8 topical clusters (pan-Hellenic,
Athenian politics, Persian Wars, Peloponnesian War, philosophers,
Alexander+Macedon, the Diadochi, arts/historiography). 19 queries,
4 conversation traces. Timestamps are years since 800 BCE (positive
integers), so Marathon = 310, Alexander's death = 477.

**Eval (A) — vs flat vector baseline, at defaults:**

```
Queries: 19    path wins: 5    baseline wins: 5    ties: 9
Mean F1 — path: 0.526    baseline: 0.544
```

Best Phase-2 configuration:

```
A3 bfs probe=weighted-fusion tau=0.2    → mean F1 0.548  (+0.022 over BFS)
```

**Eval (B) — multi-turn arc convergence:**

```
config                                   | narrowed | coherent
bfs (default) / A2 / A2+A3 / A3-fusion   | 4/4      | 0/4
```

**Headline findings:**

- **A2 does not generalize.** Tier-1's +0.102 F1 lift from graph-
  informed anchor scoring was an artifact of tier-1's `alex`-dominant
  tokenization. On tier-2, every A2 configuration regresses F1 (worst
  case 0.333 under Dijkstra α=0.5). Without a single ubiquitous
  token to penalize, IDF-mass reranking pushes the wrong anchors up.
- **A3 weighted-fusion** is the first primitive to win at *both*
  tiers without regressing the other. Robust to corpus shape where
  A2 is not.
- **Dijkstra/A1 underperform BFS at both tiers.** No configuration
  in either tier has them beating BFS.
- **Eval-B coherence fails uniformly (0/4) at tier-2.** Root cause
  is session-mode probe accumulation treating all turns equally —
  a retriever-architecture gap, not a tunable one. Narrowing (4/4)
  still holds. Probe-turn weighting is the natural next primitive
  (see `CONTEXT.md` § Phase 2 findings + "Recommended next-session
  entry point").
- **Path retriever's genuine tier-2 wins** are on cross-cluster
  and as-of queries: *Ptolemaic Egypt* (1.00 vs 0.25), *kings of
  Macedon* (1.00 vs 0.67), *as-of Academy head in 340 BCE* (1.00
  vs 0.00), *tragic playwrights* (0.33 vs 0.00). Same shape as
  tier-1 — the architecture wins where multi-probe + bitemporal-
  light are real signals, loses on single-literal-cue queries.

Run tier-2 sweeps:

```bash
TIER=tier2 bun run experiments/path-memory-smoketest/eval/sweep.ts
TIER=tier2 bun run experiments/path-memory-smoketest/eval/iterative-sweep.ts
```

## Tier-1 results (post-Phase 1.6, defaults)

**Eval (A) — vs flat vector baseline (P/R @ K=|ideal|):**

```
Queries: 12    path wins: 3    baseline wins: 3    ties: 6
Mean F1 — path: 0.530    baseline: 0.507  (defaults: BFS, raw cosine, union)
```

Best Phase-1.6 configurations (opt-in):

```
A2 dijkstra anchor=cosine-idf-mass alpha=0.8       → mean F1 0.632  (+0.102 over BFS)
A2+A3 dijkstra anchor a=0.7 probe=intersection    → mean F1 0.596  +  3/3 coherent arcs
```

A2 (graph-informed anchor scoring) is the breakthrough — first
configuration to lift mean F1 above 0.530 since Phase 1. A2+A3
(intersection) is the first config in the smoke-test's history to
converge all three eval (B) arcs, including the long-broken career
arc. A1 (temporal decay) is actively harmful at this corpus shape
and is not recommended; see `CONTEXT.md` § Phase 1.6 findings for
the full sweep table and analysis.

Query-level highlights under BFS-default:

- **Path wins decisively on as-of queries** (e.g. "where alex lived in 2015"
  → F1 1.00 vs 0.00). Bitemporal-light primitive validates.
- **Path wins on multi-claim coverage queries** (hobbies, google work artifacts)
  — multi-probe matching surfaces related claims the baseline misses at K.
- **Baseline still wins on queries with strong literal cues** ("marriage
  and partner" natural query contains "Sam" + "marriage").

**Eval (B) — multi-turn arc convergence:**

```
config                                                | narrowed | coherent
bfs (default)                                         | 3/3      | 2/3
A2 dijkstra anchor=idf alpha=0.8                      | 3/3      | 2/3
A2+A3 dijkstra anchor=idf a=0.7 probe=intersection    | 3/3      | 3/3
```

- *family arc* — converges under all configs
- *location arc (asOf)* — converges under all configs
- *career arc* — converges only under **A2+A3 intersection**;
  BFS-default still fails it.

## Hypothesis status

**Mixed, post-Phase 2.** Architectural claims hold at both tiers:
path retrieval wins decisively on as-of and multi-claim-coverage
queries, baseline wins on single-strong-cue queries, and composite
F1 is competitive (tier-2 best 0.548 vs baseline 0.544). The
*tuning* claim from Phase 1.6 does NOT hold at scale: A2 was an
artifact of tier-1's single-shared-token corpus and regresses on
tier-2. A3 weighted-fusion emerges as the first primitive that
wins at both tiers.

Eval (B) coherence collapsed on tier-2 (0/4 across every Phase-1.6
config) — session-mode probe accumulation is the next architectural
gap, and it's not addressable within the Phase-1.6 knob surface.
Next: probe-turn weighting (`CONTEXT.md` § Recommended next-
session entry point, Option E).

## Out of scope (for follow-on work)

- Tiers 2 (Greek history) and 3 (Wikipedia) datasets
- Access tracking / well-worn-path index
- Agent profile knob (facts ↔ abstractions weighting)
- Context-building step that pre-summarizes a path for a downstream prompt
- Auto-tuning of scoring weights
- Heuristic supersession (currently supersession must be marked explicitly)
- Persistence — everything is in-memory, reconstructible from data files
