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

## Phase 2.1 — tier-2 eval-B rescue attempt

Two changes landed for Phase 2.1 in response to tier-2's eval-B
coherence collapse (0/4 across every Phase-1.6 config):

1. **Option E — per-probe session decay.** `Session` now stamps each
   appended probe with a turn index, and a new `sessionDecayTau`
   retrieval option weights probes by `exp(-(maxTurn - turnIndex) / tau)`
   so later-turn probes outweigh broad early-turn ones. Weights are
   applied in three probe-consumption points: intersection vote
   (weighted-sum threshold), weighted-fusion contribution, and path
   `probeCoverage` scoring.
2. **Option F — default composition flip.** `DEFAULTS.probeComposition`
   moves from `"union"` to `"weighted-fusion"` (τ=0.2). Gives Option E
   a stable aggregation baseline that already respects per-probe
   contribution arithmetic.

`sessionDecayTau` is off by default (undefined) — full back-compat for
one-shot `PathMemory.queryWithProbes` callers that don't set turnIndex.

### Phase 2.1 results

| Metric | Legacy default (union) | New default (wfusion τ=0.2) | Best decay config |
|---|---|---|---|
| Tier-1 eval-A mean F1  | 0.530 | 0.510 | 0.510 (unchanged by decay) |
| Tier-1 eval-B coherent | 2/3   | **3/3** | 3/3 |
| Tier-2 eval-A mean F1  | 0.526 | **0.548** | 0.548 |
| Tier-2 eval-B coherent | 0/4   | 0/4   | **1/4** (τ=0.3 or 0.05) |

**Headline takeaways:**

- The default flip **lifted tier-1 eval-B from 2/3 to 3/3** —
  unexpected win. Phase-1.6's career-arc was the only missing arc
  under the union default, and it converges under weighted-fusion
  even without decay.
- The default flip **lifted tier-2 eval-A by +0.022 F1** (matches the
  Phase-2 leader) at the cost of a **−0.020 tier-1 eval-A regression**
  (within noise of the previous 0.530 baseline).
- Session decay lifted tier-2 eval-B coherence from 0/4 to **1/4**
  at its best config (τ=0.3 — Academy arc converges). The primitive
  helps but **does NOT meet the ≥ 2/4 Option-E pass criterion alone**
  — the three cross-cluster arcs (philosophers→Alexander, Athens at
  war, Alexander succession) still miss their late-turn targets even
  with latest-turn-only weighting (τ≈0.05).
- Tier-1 eval-B is robust to every swept decay value (3/3 coherent
  at all taus from 0.05 through 5.0) — no tier-1 regression from the
  new primitive.

**Scientific interpretation:** the tier-2 eval-B gap is a **two-problem
gap**. Probe-turn weighting addresses *session accumulation*, but the
remaining failure mode is **anchor-cloud displacement** — the late-turn
probes' top-K anchors land in the *wrong* topical cluster when the
cross-cluster path depends on traversal through a named entity
("Aristotle's most famous pupil" → `phil_aristotle_tutors_alexander`)
that is itself cross-cluster. The retrieved anchor set at the latest
turn is topically correct but structurally isolated from the expected
claim. Next primitive needs to reshape *anchor selection* itself under
a weighted-probe regime — e.g. anchor-boost proportional to late-turn
cosine density, or graph-neighborhood reconciliation post-anchor. Plan
and analysis: `CONTEXT.md` § Phase 2.1 findings.

Run Phase-2.1 sweeps:

```bash
# Option E sweep across 12 configs on either tier
TIER=tier1 bun run experiments/path-memory-smoketest/eval/iterative-sweep.ts
TIER=tier2 bun run experiments/path-memory-smoketest/eval/iterative-sweep.ts
```

## Tier-2 results (Phase 2)

Greek-history corpus: 242 claims across 8 topical clusters (pan-Hellenic,
Athenian politics, Persian Wars, Peloponnesian War, philosophers,
Alexander+Macedon, the Diadochi, arts/historiography). 19 queries,
4 conversation traces. Timestamps are years since 800 BCE (positive
integers), so Marathon = 310, Alexander's death = 477.

**Eval (A) — vs flat vector baseline, at defaults:**

At Phase-2 defaults (pre-Phase-2.1, i.e. BFS + union + raw cosine):

```
Queries: 19    path wins: 5    baseline wins: 5    ties: 9
Mean F1 — path: 0.526    baseline: 0.544
```

Best Phase-2 configuration — **promoted to default in Phase 2.1**:

```
A3 bfs probe=weighted-fusion tau=0.2    → mean F1 0.548  (+0.022 over BFS+union)
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

## Tier-1 results (post-Phase 1.6, legacy union default)

**Eval (A) — vs flat vector baseline (P/R @ K=|ideal|):**

```
Queries: 12    path wins: 3    baseline wins: 3    ties: 6
Mean F1 — path: 0.530    baseline: 0.507  (defaults: BFS, raw cosine, union)
```

> Under the Phase-2.1 post-flip default (weighted-fusion τ=0.2),
> tier-1 mean F1 becomes 0.510 — within noise. Tier-1 eval-B
> coherence *improves* from 2/3 to 3/3 under the new default. See
> "Phase 2.1" above.

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

**Mixed, post-Phase 2.1.** Architectural claims hold at both tiers:
path retrieval wins decisively on as-of and multi-claim-coverage
queries, baseline wins on single-strong-cue queries, and composite
F1 is competitive (tier-2 best 0.548 vs baseline 0.544). The
*tuning* claim from Phase 1.6 does NOT hold at scale: A2 was an
artifact of tier-1's single-shared-token corpus and regresses on
tier-2. A3 weighted-fusion (now the default) is robust to corpus
shape and is the first primitive that wins at both tiers.

Phase 2.1 landed per-probe session decay (Option E) and promoted
A3 weighted-fusion to default (Option F). The default flip
unexpectedly lifted tier-1 eval-B from 2/3 to 3/3; session decay
lifted tier-2 eval-B from 0/4 to 1/4. The remaining tier-2 gap
(3/4 cross-cluster arcs still miss) is structural — a
second primitive is required. See `CONTEXT.md` § Phase 2.1
findings for the full analysis.

Phases 2.2 and 2.3 landed two new `AnchorScoring` variants as
opt-in infrastructure: **Option I** (`weighted-probe-density` —
linear cosine-density aggregate) and **Option J**
(`density-coverage-bonus` — super-linear probe-coverage reward;
`min-cosine-gate` — hard k=P gate). All four configurations
**preserve** Phase-2.1 baselines but **none lift tier-2 eval-B
beyond 1/4**. The exponent sweep (`k^(exp−1)` for
`exp ∈ {1.5, 2, 3}`) is behaviorally flat on coherence, refuting
the Phase-2.1 hypothesis that anchor-cloud displacement is a
"strong-peak-vs-moderate-spread" ranking flip. Failure-mode
inspection in CONTEXT.md § Phase 2.3 identifies the three
still-failing arcs as **cross-cluster expected answers** — a
graph-structural problem (cluster-boundary handling), not an
anchor-scoring one. Next candidate: **Option H**
(topic/cluster-conditional edge weights or anchor boosts).

## Out of scope (for follow-on work)

- Tiers 2 (Greek history) and 3 (Wikipedia) datasets
- Access tracking / well-worn-path index
- Agent profile knob (facts ↔ abstractions weighting)
- Context-building step that pre-summarizes a path for a downstream prompt
- Auto-tuning of scoring weights
- Heuristic supersession (currently supersession must be marked explicitly)
- Persistence — everything is in-memory, reconstructible from data files
