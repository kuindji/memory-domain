# Path-Memory Smoke-Test — Context & Next-Session Plan

> This document captures the **why** behind the smoke-test and the **next
> scope of work**. For the current state of the code and results, see
> `README.md`. For the decision log that produced this design, see
> `~/.claude/plans/swirling-churning-spindle.md`.

---

## Part 1 — What We're Trying to Achieve

### The problem

Agent memory is one of the major unsolved problems in AI systems today. The
requirements are deceptively simple:

1. **Fast** — an agent makes many memory calls per turn and can't afford
   hundreds of milliseconds per lookup.
2. **Accurate** — the *right* information has to surface, not just
   semantically-similar-looking information.
3. **Structured** — memory must represent change over time, supersession,
   causal and topical relationships — not just a flat blob.
4. **Composable with reasoning** — memory should be a participant in the
   agent's reasoning loop, not a glorified lookup table.

Existing tools (vector DBs, RAG, graph DBs) each solve *parts* of this, but
none solves the whole problem. The gap between "document retrieval" (which
existing IR was designed for) and "agent memory" (what we actually need) is
larger than it looks.

### The conceptual framework we arrived at

Through a long design conversation we converged on a specific model:

- **Memory is a network, not a list.** A single graph connecting everything
  from individual tokens to high-level abstractions. Every agent accesses
  the same substrate; what differs per agent is *which paths get worn*.
- **What's stored is the history of this network.** Additions, supersessions,
  and revisions form an append-only log. The current state is a derived view.
- **What's indexed are well-worn paths.** Frequently-accessed trajectories
  through the graph become shortcuts; infrequent regions remain but are
  expensive to traverse.
- **Relevance is agent-specific.** Different agents emphasize different parts
  of the same substrate (some favor facts, some favor abstractions).
  Relevance cannot be computed without knowing the goal / profile.
- **Retrieval matches probe-sets against paths.** A query becomes a *set* of
  probe vectors; retrieval finds paths through the graph that touch multiple
  probes. This is closer to how associative human recall works than to
  cosine top-k.
- **Branching ≠ supersession.** For agentic memory, we collapse to a simpler
  model: default queries see *current state* only (fast); opt-in queries see
  *state at time t* (slower, never taxes the default path). Conflicting
  parallel branches (the human "two contradictory beliefs coexist" case) are
  explicitly out of scope.

### Why this is hard (and still unsolved)

- **Embeddings collapse structure.** "User lived in NYC" and "User lives in
  NYC" are near-identical in cosine space; neither vector carries the
  "supersedes" relationship.
- **Indexes are static; memory is alive.** Supersession, decay, merging, and
  reinforcement need first-class support.
- **Relevance ≠ similarity.** What the agent needs is "what should I know to
  act correctly right now" — which depends on goal, conversation history,
  and user identity.
- **Paths have combinatorial structure.** You can't pre-embed every possible
  path through a graph; you have to discover them at query time.
- **No unified theory.** Each piece (dynamical systems, AGM belief revision,
  POMDPs, information bottleneck, active inference) is formalized in
  isolation. The joint object — *an agent's situated relevance* — is a
  research-grade open problem.

So autotuning alone won't close the gap: you need the right primitives in
the search space first. Tuning is the last 20%, not the first 80%.

### Positioning relative to existing systems

| System | What it does | How we differ |
|---|---|---|
| **ColBERT** | Multi-vector late-interaction retrieval over documents | We apply the multi-probe primitive to *paths through a graph*, not to document tokens |
| **XTDB / Datomic** | Bitemporal immutable-fact stores | We use a simplified bitemporal-light (valid-time only, supersession as the write primitive, no transaction-time dimension) |
| **GraphRAG (Microsoft)** | LLM-extracted KG + community summaries + graph traversal | We use *structural* edges (temporal / lexical / semantic-cosine), no LLM extraction, no summaries; the retrieved path *is* the answer |
| **Zep / Graphiti** | LLM-extracted temporal knowledge graph | We don't extract — claims are pre-authored. Evaluation is apples-to-apples on retrieval primitives alone |
| **Mem0** | Hot/cold memory tiers + LLM-based fact extraction | No LLM, no tiers; we focus on retrieval semantics, not lifecycle management |
| **Letta / MemGPT** | Hierarchical memory + archival swap for context-window management | Different problem; we address retrieval, not context window |
| **TerminusDB** | Git-for-data (branching + merge) | Branching with merge is explicitly out of scope; agentic memory collapses to linear history with invalidation |
| **Hebbian / spreading-activation** (cog-sci) | Associative activation networks | Inspiration for "well-worn paths" and emergent abstraction — not yet implemented in smoke-test |
| **node2vec / DeepWalk** | Path embeddings via random walks | We don't pre-embed paths; we discover them at query time via bounded BFS |

The smoke-test is a *recombination* of these primitives, with two explicit
departures: **no LLM in the memory layer** and **paths (not documents or
nodes) as the retrieval unit**.

---

## Part 2 — What We've Built

### Scope of this smoke-test

Per the approved plan (`~/.claude/plans/swirling-churning-spindle.md`):

- **Core implementation** — store, graph, retriever, interfaces, embedder
- **Tier-1 dataset** — 38 hand-authored claims about a fictional "Alex"
- **Eval harness** — precision/recall vs flat vector baseline (eval A),
  multi-turn arc convergence (eval B)
- **Explicitly out of scope** — tiers 2/3, access tracking, agent profile,
  context-building, auto-tuning

### Architecture

```
              ┌────────────────────────┐
              │  Test Harness / Agent  │
              └────────────┬───────────┘
                           │ probes (vec[]) | query (str)
                           ▼
              ┌────────────────────────┐
              │      Retriever         │  stateless; pure function over
              │  (multi-probe matcher) │  store + graph state
              └────────────┬───────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
┌──────────────────┐                ┌─────────────────────┐
│  MemoryStore     │◄───────────────│  GraphIndex         │
│  claims +        │   ingestion    │  temporal +         │
│  bitemporal-     │   updates      │  lexical +          │
│  light metadata  │   both         │  semantic edges     │
└──────────────────┘                └─────────────────────┘
```

**Component boundaries (deliberate, each file does one thing):**

- `store.ts` owns claim records and bitemporal-light semantics
  (`valid_from`/`valid_until`, history log, supersession). Knows nothing
  about edges or retrieval.
- `graph.ts` owns edges. Knows nothing about bitemporal semantics — asks
  the store for currency at query time.
- `retriever.ts` is a *stateless* function over store + graph. Takes a
  probe set, returns scored paths. No accumulated state across calls.
- `interfaces.ts` (`PathMemory` + `Session`) provides the agent-facing
  facade and the iterative-refinement helper. Session accumulates probes
  across conversation turns — **iterative refinement is a harness
  responsibility, not a retriever feature**, keeping the retriever
  composable.
- `embedder.ts` wraps the parent project's `OnnxEmbeddingAdapter`
  (all-MiniLM-L6-v2 via ONNX runtime) + cache. Deterministic, local, no
  API calls.

### Data model

- **Claim** = `{ id, text, embedding, tokens, validFrom, validUntil,
  supersedes? }`. Text + time are the primary inputs; embedding and tokens
  are computed at ingestion.
- **Edges** = `{ type, from, to, weight, meta }` where type is one of
  `temporal` (linked-list in validFrom order), `lexical` (shared tokens,
  weighted by jaccard), `semantic` (cosine ≥ threshold).
- **HistoryEvent** = `{ kind: "ingest" | "supersede", ... }`. Append-only
  log used only for `as-of` queries.

### Retrieval algorithm

1. **Anchor lookup** — for each probe, find top-K nodes by cosine similarity.
2. **Path discovery** — for each pair of distinct anchors, bounded BFS (max
   depth D) finds shortest connecting path through the graph.
3. **Path scoring** — for each candidate path:
   ```
   score = probeCoverage·w_pc
         + edgeTypeDiversity·w_etd
         + recency·w_r
         - lengthPenalty·w_lp
   ```
   with defaults `w_pc=1.0, w_etd=0.3, w_r=0.1, w_lp=0.1`.
4. **Dedup + top-N** — canonical path key deduplicates, top-N returned.
5. **Mode** — `current` (default, fast, only non-superseded claims) or
   `asOf(t)` (opt-in, walks history to reconstruct state at time t).

### Results (tier-1, post-Phase-1, default weights)

**Eval (A) — vs flat vector baseline (P/R @ K = |ideal|):**
```
Queries: 12    path wins: 3    baseline wins: 3    ties: 6
Mean F1 — path: 0.530    baseline: 0.507
```

Same aggregate numbers as the pre-Phase-1 run (0.530) — see Phase 1
findings below for what did and didn't move.

Highlights:
- Path retriever **wins decisively on as-of queries** (where-did-alex-live-in-2015:
  F1 1.00 vs 0.00). The bitemporal-light primitive works.
- Path retriever **wins on multi-claim-coverage queries** (hobbies,
  google-work-artifacts): multi-probe finds related claims baseline misses
  at small K.
- Baseline **wins on queries with strong literal cues** in the natural
  query string (e.g. "marriage and Sam" cues marry_sam directly).

**Eval (B) — multi-turn arc convergence:**
```
Arcs: 3    narrowed: 3    coherent (≥0.5): 2
```

- Family arc: converges cleanly across 4 turns
- Location arc (asOf): converges
- Career arc: does NOT converge — accumulating probes across "what-did-alex-study"
  through "role-at-microsoft" pulls in noise via lexical edges on "Alex"

### Phase 1 findings

Phase 1 landed three changes (see `~/.claude/plans/temporal-churning-dijkstra.md`):

1. **Informational length penalty** — replace `hops/maxDepth` with
   `max(0, hops - (anchors-1))/maxDepth`. A pure-anchor path pays no
   penalty; only connective (non-anchor) hops cost. This is the only
   change active by default and is the real Phase-1 win — no regression,
   slightly more decisive outcomes on a handful of queries.

2. **IDF-weighted lexical edges** — `GraphIndex` now tracks document
   frequency and recomputes lexical edge weights on each ingest using
   smoothed IDF-jaccard:
   `w = sum(idf(shared)) / sum(idf(union))`,
   `idf(t) = ln((N+1)/(df(t)+1)) + 1`. Weights are correct (verified by
   unit tests) — ubiquitous-token edges have substantially lower weight
   than rare-token edges.

3. **`pathQuality` score term** — available via
   `RetrievalOptions.weights.pathQuality`, defaulting to **0**. Solo
   paths get `pathQuality=0` (no edges to evaluate); multi-edge paths
   get the average edge weight. Default zero because a sweep across
   `pathQuality ∈ {0.05, 0.1, 0.2, 0.3, 0.5, 1.0}` and
   `lexicalIdfFloor ∈ {0, 0.15, 0.2, 0.25, 0.3}` on eval (A) showed
   **no configuration improved mean F1 above 0.530**. Turning on
   `pathQuality` with `floor=0` tips some single-claim queries into
   losses (first-child, as-of-2015) because low-weight lexical hops
   dilute scoring in ways the current BFS can't compensate for; turning
   on `floor` prunes edges BFS needs for legitimate connections.

### What this tells us

The IDF signal is present in the graph but not actionable with the
current BFS. Shortest-path-by-hops treats all edges equally, so the
weight distinction only reaches scoring, where it behaves like noise at
this dataset size. The unit tests (`graph.test.ts`) confirm the IDF
machinery works — it just doesn't lift ranking quality through the
score alone.

**Likely Phase 1.5:** weight-aware traversal (Dijkstra with
`1 − edgeWeight` or similar) so the path *choice* respects IDF, not just
its scoring. This was flagged as out-of-scope for Phase 1 deliberately
so we could observe score-level effects first; the observation is that
score alone isn't enough.

**Career-arc convergence still fails** for the same reason: probe
accumulation reaches unrelated claims via low-weight "alex" edges that
BFS freely traverses.

### Phase 1.5 findings

Phase 1.5 implemented bounded-depth Dijkstra over
`cost = max(0, 1 − edge.weight)` for lexical/semantic edges, with a
fixed per-temporal-hop cost (`temporalHopCost`, default 0.5) so the
timeline isn't a free corpus-wide highway. Ships as **opt-in traversal**
(`RetrievalOptions.traversal = "dijkstra"`); BFS remains the default.

Sweep over `temporalHopCost ∈ {0, 0.3, 0.5, 0.7, 1.0}` and
`pathQuality ∈ {0, 0.3}` with and without `lexicalIdfFloor` on eval (A):

```
config                                | mean-path-F1 | wins | losses
bfs (default)                         | 0.530        | 3    | 3
dijkstra tmp=0.0, pq=0                | 0.417        | 2    | 6
dijkstra tmp=0.3, pq=0                | 0.367        | 3    | 6
dijkstra tmp=0.5, pq=0                | 0.510        | 5    | 4
dijkstra tmp=0.7, pq=0                | 0.510        | 5    | 4
dijkstra tmp=1.0, pq=0                | 0.510        | 5    | 4
dijkstra tmp=0.5, pq=0.3              | 0.433        | 4    | 5
dijkstra tmp=0.7, pq=0.3              | 0.454        | 4    | 4
dijkstra tmp=0.5, floor=0.15, pq=0.3  | 0.462        | 2    | 5
```

Findings:

1. **`temporalHopCost ≈ 0` is actively harmful.** With the whole timeline
   free, Dijkstra drags paths through temporally-adjacent but topically-
   irrelevant claims (e.g. `conf_neurips` bleeding into the family arc).
   Plateau lifts as cost climbs, stabilizing at **0.510** from
   `temporalHopCost ≥ 0.5`.
2. **Dijkstra is more decisive but no better in aggregate.** Best
   Dijkstra config: 5 wins / 4 losses vs BFS's 3 / 3 — more queries
   shift direction, but the net is ~0.02 F1 *below* BFS.
3. **pathQuality and lexicalIdfFloor still don't help under weighted
   traversal** — confirming Phase 1's observation that the score/prune
   knobs are ineffective on tier-1 at this corpus size.
4. **Eval (B): 2/3 coherent arcs preserved under BFS; Dijkstra drops to
   1/3** at `tmp=0.5`. The first-child query is a notable Dijkstra
   regression (BFS 1.00 → Dijkstra 0.00 at same K) — the child_lily
   solo path gets outscored by weight-optimized multi-hop paths
   through unrelated nodes.

### Hypothesis status

**Partially supported, post-Phase 1.5.** Architecture works end-to-end,
bitemporal-light validates strongly, multi-probe path-matching adds
value on specific query types — but at tier-1 scale with this corpus
shape (~38 claims, `alex`-dominant tokenization), neither BFS nor
weighted Dijkstra dominates the flat baseline at default weights.

Of the two Phase-1 failure modes originally identified:

1. **Length-penalty / multi-anchor trade-off** — *fixed*. Informational
   length penalty (hops minus anchors-in-path) is live by default and
   does not regress F1.
2. **Lexical edge noise from ubiquitous tokens** — *not fixed at the
   ranking or traversal layer*. IDF-weighted edge weights are correctly
   computed and observable; neither `pathQuality` scoring, `lexicalIdfFloor`
   pruning, nor weight-aware Dijkstra improves mean F1 on tier-1.

CONTEXT.md's Phase 1.5 prediction held: *"If this doesn't lift tier-1
F1 above 0.58ish, the conclusion is primitive-limited, not tuning-
limited."* Confirmed on tier-1.

### Files delivered

```
experiments/path-memory-smoketest/
├── README.md                   # how-to-run + results summary
├── CONTEXT.md                  # this file — why + next steps
├── tsconfig.json               # extends parent; includes only this dir
├── src/
│   ├── types.ts                # Claim, Edge, HistoryEvent, Path, ScoredPath, options
│   ├── store.ts                # MemoryStore — bitemporal-light store
│   ├── graph.ts                # GraphIndex — three-edge-type builder
│   ├── tokenize.ts             # stopword-filtered tokenizer
│   ├── retriever.ts            # multi-probe matcher; BFS + Dijkstra traversal
│   ├── interfaces.ts           # PathMemory + Session facades
│   └── embedder.ts             # ONNX embedder factory (wraps parent adapter)
├── data/
│   └── tier1-alex.ts           # 38 hand-authored claims
├── eval/
│   ├── baseline.ts             # flat vector-search baseline
│   ├── queries-tier1.ts        # 12 queries with marked ideal answers
│   ├── conversation-traces-tier1.ts  # 3 multi-turn traces
│   └── sweep.ts                # manual config-sweep helper over eval (A)
└── tests/
    ├── helpers.ts              # deterministic fake embedder + wiring
    ├── embedder.test.ts        # real embedder smoke test
    ├── store.test.ts           # 7 bitemporal invariants
    ├── graph.test.ts           # 13 edge-formation + IDF invariants
    ├── retriever.test.ts       # 11 retrieval behaviors
    ├── eval-vs-baseline.test.ts   # eval (A) — vs flat baseline
    └── eval-iterative.test.ts  # eval (B) — multi-turn convergence
```

35 tests pass. Typecheck clean. Smoke-test lint clean (pre-existing
errors in `src/plugins/topic-linking.ts` unrelated to this branch).

---

## Part 3 — Plan for Next Session

Scope ordered by ROI on the information gained. Each item is independently
landable and doesn't require the previous one — prioritize based on which
question you most want answered next.

### Phase 1 — tier-1 failure-mode fixes — **done**

See "Phase 1 findings" in Part 2. Landed:
- Informational length penalty (live, default).
- IDF-weighted lexical edges (computed on each ingest; exposed via
  `edge.weight` and `GraphIndex.idf(token)`).
- `pathQuality` score term + `lexicalIdfFloor` graph-config knob — both
  infrastructure, default weights/floor disable them because no sweeped
  configuration lifted mean F1 above 0.530 on tier-1.

### Phase 1.5 — weight-aware traversal — **done, shipped opt-in**

See "Phase 1.5 findings" in Part 2. Landed:
- Bounded-depth Dijkstra over `cost = max(0, 1 − edge.weight)` for
  lexical/semantic edges; temporal edges take a fixed `temporalHopCost`
  (default 0.5) to avoid a free timeline highway.
- `traversal: "bfs" | "dijkstra"` option (default `"bfs"`) so the
  weighted traversal is available without changing default behavior.
- Sweep harness extended with the traversal knob.

Outcome: no tier-1 F1 lift at default weights (best Dijkstra 0.510 vs
BFS 0.530). Confirmed "primitive-limited, not tuning-limited" per
Phase 1.5's own pass-condition. Infrastructure retained for tier-2 +
future primitive changes (see below).

### Phase 2 — Tier-2 dataset (Greek history) — medium scope

Larger, more topically-diverse corpus than Alex. Tier-2 will expose whether:
- The architecture scales to ~200-500 claims
- Topical clusters emerge cleanly in the embedding space
- Multi-probe traversal finds cross-topic paths (e.g., "philosophers who
  influenced Alexander the Great" — spans two topics)

Work:
- Author ~200 Greek-history claims with timestamps, explicit supersession
  for disputed facts
- Design ~15-20 tier-2 queries including multi-topic and historical-state
  ones
- Run eval (A) and (B); compare to tier-1 to see if path-retrieval advantage
  grows or shrinks with scale

### Phase 3 — Access tracking instrumentation (small, observability-only)

Add node/edge access counters to the graph. **Don't yet exploit them in
scoring.** Just observe which paths get worn through eval (B) conversation
traces. Expected payoff: a plot/report showing that frequently-accessed
paths concentrate in a few regions — the empirical foundation for the
next step.

### Phase 4 — Exploit well-worn paths (medium)

Once observation data exists, extend the retriever with a well-worn-path
cache:
- Maintain an index of top-K most-accessed paths
- On query, consult the cache first before running BFS — if the query's
  probe set overlaps strongly with a cached path's nodes, surface the
  cached path directly
- Measure: speedup on repeated/similar queries, F1 impact

### Phase 5 — Agent profile knob

A single scalar `profileAbstractionPreference ∈ [0, 1]`:
- 0 = facts-leaning → higher weight on lexical/literal matches
- 1 = abstractions-leaning → higher weight on semantic-cluster cohesion
- Default 0.5

Same substrate, different path rankings per agent. Eval: does a
facts-leaning profile find different top paths than an abstractions-leaning
one on the same queries? Does F1 improve when profile matches query type?

### Phase 6 — Context-building step

The smoke-test returns paths. Real agent use requires converting a path into
prompt-ready context (path → narrative summary). This is a mechanical step
but the first place an LLM would enter the system.

Design questions to resolve:
- Stays out of the memory layer (stays LLM-free) or allowed to use LLM for
  summarization only?
- Token-budget-aware truncation
- How to represent "valid at t" in the summary

### Phase 7 — Tier-3 Wikipedia corpus

Disparate topical areas from Wikipedia. This is the scaling test:
- 5,000+ claims, multiple unrelated domains
- Performance becomes a real constraint (BFS bounds, adjacency sizes)
- Likely need to revisit storage: move off in-memory Maps onto something
  with an ANN index. Qdrant or pgvector + AGE are candidates.
- This is where the "integration into memory-domain proper" question
  becomes concrete.

### Phase 8 — Integration back into memory-domain

If tiers 1-3 all validate, the question becomes how to fold this back into
the production memory-domain codebase. Options:
- **Pluggable retrieval mode** — add `pathRetrieve` alongside existing
  `graphSearch` / vector search. Users opt in per query.
- **Replace current retriever** — higher risk, higher reward. Would need
  migration path for existing consumers.
- **Separate package** — keeps the architectural purity but fragments the
  API.

This decision deserves its own brainstorm, not a plan entry. Defer until
tier-3 results are in.

### Not in next-session scope

- Auto-tuning of weights (needs a real optimization loop and a labeled
  corpus larger than tier-1)
- Heuristic supersession (requires cheap entity resolution which is
  non-trivial without LLM)
- Persistence / storage engine swap (premature until scaling becomes a
  real constraint in tier-3)

### Recommended next-session entry point

Phase 1.5 is done and confirmed tier-1 is primitive-limited: neither
IDF-weighted scoring, pruning, nor weight-aware traversal lifts F1
above BFS. Two plausible next directions, each independently landable:

**Option A — primitive revisit (deeper, higher ROI if it works):**
investigate alternatives that change *what's in the search space*, not
how we walk it. Candidates in order of cheapness:
- **Temporal-weight decay by `deltaT`** — temporal edges currently have
  uniform weight 1 (cost override 0.5). Replace with `weight = f(1/deltaT)`
  so close-in-time adjacency costs much less than distant adjacency.
  May fix the first-child regression without re-introducing the
  free-highway failure mode.
- **Anchor re-selection** — top-K cosine is noisy on tier-1 (the
  family/career regressions often stem from bad anchors, not bad
  traversal). Try graph-informed anchor scoring (neighbor weight mass,
  IDF-weighted cosine).
- **Probe composition** — currently probes are independent; their
  anchor sets are unioned. Consider intersection/weighted fusion for
  multi-probe queries.

**Option B — Phase 2 (tier-2 Greek-history corpus):** stop tuning on
tier-1 and test the architecture at the intended scale (~200-500
claims, multi-topic). Tier-1 may simply be too small to differentiate
retrieval strategies — every claim shares `alex`, every anchor pair
is ≤ 2 hops apart via direct lexical edges. Tier-2 exposes whether
Dijkstra's weight-awareness starts paying off when the graph is
sparser and topics are more diverse.

Recommendation: **Option A first, Option B second.** A is cheap (small
graph.ts / retriever.ts changes, same eval harness), and the result
either closes the tier-1 F1 gap or provides the "we've exhausted
primitive tweaks on tier-1" evidence that unblocks B. Running B first
risks inheriting the wrong primitives into the larger-corpus test.

Then let the results decide whether to go wider (tier-2 dataset) or
deeper (access tracking + agent profile).
