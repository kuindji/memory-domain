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
  (BGE-small-en-v1.5 via ONNX runtime, CLS-pooled + L2 normalized —
  pre-Phase-2.7 this was MiniLM-L6-v2) + cache. Deterministic,
  local, no API calls.

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

### Phase 1.6 findings

Phase 1.6 implemented all three Option-A primitive revisits as opt-in
options:

1. **A1 — temporal-weight decay by `deltaT`.** New
   `GraphConfig.temporalDecayTau`; when set, temporal edges receive
   `weight = exp(-deltaT / tau)`. Dijkstra reads
   `temporalDecayEnabled()` and uses
   `cost = temporalHopCost · (1 − weight)` instead of the flat
   Phase-1.5 cost.
2. **A2 — graph-informed anchor scoring.** New
   `RetrievalOptions.anchorScoring = { kind: "cosine-idf-mass", alpha }`;
   anchor score becomes `cosine · (1 + alpha · normalizedNodeIdfMass)`
   where `normalizedNodeIdfMass = sum(idf(t) for t in tokens) /
   maxNodeIdfMass`. New `GraphIndex.nodeIdfMass(id)` helper.
3. **A3 — probe composition.** New
   `RetrievalOptions.probeComposition: "union" | "intersection" |
   "weighted-fusion"`. Intersection requires anchor in
   `≥ ceil(P/2)` per-probe top-K sets; weighted-fusion ranks claims
   by `sum_p max(0, cos(p, claim) − tau)` (`weightedFusionTau` default
   0.2). Both fall back to union if no anchor passes their gate
   (defensive — prevents empty results).

Sweep over eval (A), 12 queries:

```
config                                                    | mean-path-F1 | wins | losses
bfs (default)                                             | 0.530        | 3    | 3
dijkstra tmp=0.5                                          | 0.510        | 5    | 4
A1 dijkstra tau=2  tmp=0.5                                | 0.403        | 2    | 5
A1 dijkstra tau=5  tmp=0.5                                | 0.424        | 2    | 4
A1 dijkstra tau=10 tmp=0.5                                | 0.340        | 1    | 4
A2 bfs anchor=idf alpha=0.5                               | 0.545        | 2    | 3
A2 bfs anchor=idf alpha=0.7                               | 0.555        | 3    | 2
A2 bfs anchor=idf alpha=1.0                               | 0.475        | 3    | 3
A2 dijkstra tmp=0.5 anchor=idf alpha=0.3                  | 0.510        | 5    | 4
A2 dijkstra tmp=0.5 anchor=idf alpha=0.5                  | 0.580        | 4    | 4
A2 dijkstra tmp=0.5 anchor=idf alpha=0.6                  | 0.568        | 5    | 4
A2 dijkstra tmp=0.5 anchor=idf alpha=0.7                  | 0.617        | 5    | 2
A2 dijkstra tmp=0.5 anchor=idf alpha=0.8                  | 0.632        | 3    | 1
A2 dijkstra tmp=0.5 anchor=idf alpha=0.9                  | 0.632        | 3    | 1
A2 dijkstra tmp=0.5 anchor=idf alpha=1.0                  | 0.590        | 2    | 1
A3 bfs probe=intersection                                 | 0.530        | 3    | 3
A3 bfs probe=weighted-fusion tau=0.2                      | 0.510        | 3    | 2
A3 dijkstra tmp=0.5 probe=intersection                    | 0.489        | 5    | 5
A3 dijkstra tmp=0.5 probe=weighted-fusion tau=0.2         | 0.468        | 4    | 3
A2+A3 dijkstra anchor=idf a=0.5 probe=intersection        | 0.587        | 4    | 4
A2+A3 dijkstra anchor=idf a=0.7 probe=intersection        | 0.596        | 5    | 3
A2+A3 dijkstra anchor=idf a=0.5 fusion tau=0.2            | 0.468        | 4    | 3
A1+A2 dijkstra tau=5 anchor=idf alpha=0.5                 | 0.407        | 1    | 5
A1+A2+A3 dijkstra tau=5 anchor=idf a=0.5 fusion tau=0.2   | 0.431        | 2    | 2
```

Eval (B) — multi-turn arc convergence on promoted configs:

```
config                                                | narrowed | coherent
bfs (default)                                         | 3/3      | 2/3
A2 dijkstra tmp=0.5 anchor=idf alpha=0.7              | 3/3      | 2/3
A2 dijkstra tmp=0.5 anchor=idf alpha=0.8              | 3/3      | 2/3
A2+A3 dijkstra anchor=idf a=0.7 probe=intersection    | 3/3      | 3/3
```

**Findings:**

1. **A1 is actively harmful at this corpus shape.** Every tau tested
   regresses F1 vs both BFS and the Phase-1.5 Dijkstra plateau.
   Decay re-introduces the "free timeline highway" failure mode
   Phase 1.5 already identified — at tier-1's tight integer-year
   timestamp range, any tau small enough to differentiate adjacent
   from distant hops also makes adjacent hops nearly free, so
   Dijkstra drags paths through topically-irrelevant timeline
   neighbors. Larger tau (10) flattens the signal back toward
   "everything is free," compounding the regression. **Conclusion:**
   `deltaT` is the wrong signal for temporal cost on this corpus;
   what we actually want is *topic-conditional* temporal cost (cheap
   only when neighbors share lexical/semantic context). Out of
   scope here.

2. **A2 is the breakthrough.** First config to lift mean F1 above
   0.530 since Phase 1. With Dijkstra at `alpha = 0.8–0.9`, F1
   reaches **0.632 (+0.102 over BFS)**; with BFS at `alpha = 0.7`
   it reaches **0.555**. The IDF-mass term down-weights `alex`-only
   anchors that previously polluted top-K, replacing them with
   higher-information-content claims. Effect plateaus past
   `alpha ≈ 0.8` and breaks down near `alpha = 1.0` (over-emphasis
   pulls in rare but irrelevant claims). The Dijkstra+A2 synergy is
   real (+0.077 over A2-with-BFS at α=0.7) — once anchors carry more
   IDF mass, weighted traversal has higher-quality endpoints to
   work with.

3. **A3 alone is neutral or harmful, but A3 *with* A2 fixes the
   career arc.** Intersection on top of A2 (α=0.7) hits **3/3
   coherent arcs** in eval (B) — the first config since the
   smoke-test began that converges all three traces, including
   the long-broken career arc. Per-arc F1 is slightly lower
   (0.596 vs 0.617 for A2-alone) but the multi-turn coherence
   gain is the more interesting result for agent-memory use.
   Weighted-fusion mode is consistently worse than intersection
   here — the additive sum-of-(cos-tau) signal isn't sharp enough
   on this corpus.

4. **A1 ⊕ A2 / A1 ⊕ A2 ⊕ A3 all regress.** A1's harm dominates
   any combination it joins.

### Hypothesis status

**Strongly supported, post-Phase 1.6.** Both Phase-1.6 pass
criteria are met on tier-1:

- *Strong*: A2 (Dijkstra + anchor=idf, α=0.8) lifts mean F1 to
  0.632 (**+0.102 ≥ +0.02**) without eval (B) regression
  (still 2/3 coherent arcs, same as BFS).
- *Bonus*: A2+A3 (Dijkstra + anchor=idf α=0.7 + intersection)
  hits 0.596 F1 **and** 3/3 coherent arcs — first config in the
  smoke-test's history to converge all three iterative traces.

Of the four originally-identified Phase-1 failure modes:

1. **Length-penalty / multi-anchor trade-off** — *fixed in
   Phase 1* (informational length penalty).
2. **Lexical edge noise from ubiquitous tokens at scoring** —
   IDF-weighted edge weights computed but did not help via
   `pathQuality` or `lexicalIdfFloor`.
3. **Lexical edge noise via traversal** — *partially addressed
   in Phase 1.5 with weighted Dijkstra*; no F1 lift on its own.
4. **Anchor selection biased by ubiquitous tokens** — *fixed in
   Phase 1.6 A2*. Moving the IDF correction from edge-scoring
   (where it was inert) to anchor-selection (where it gates which
   claims can participate in path discovery at all) was the right
   primitive change.

CONTEXT.md's Phase 1.5 prediction was that tier-1 was
"primitive-limited, not tuning-limited." Confirmed: a *primitive*
change — moving IDF from edge-scoring to anchor-selection — lifted
F1 substantially, where every tuning knob in Phases 1 and 1.5
failed.

### Phase 2 findings — tier-2 Greek-history corpus

Phase 2 authored a 242-claim Greek-history corpus (776 BCE through
the Diadochi) across 8 topical clusters: pan-Hellenic/religious,
Athenian politics, Persian Wars, Peloponnesian War, philosophers,
Alexander+Macedon, Diadochi, and arts/historiography. 9 legitimate
supersessions (state transitions only: government type, ruler of a
region, head of a school). 19 queries in 4 categories (cross-cluster
multi-probe, within-cluster multi-claim, as-of, strong-literal-cue
control). 4 conversation traces. Deliberately no shared ubiquitous
token across all claims (unlike tier-1's `alex`).

Sweep over eval (A), 19 queries at default weights:

```
config                                                    | mean-path-F1 | wins | losses
bfs (default)                                             | 0.526        | 5    | 5
dijkstra tmp=0.5                                          | 0.412        | 4    | 8
A1 dijkstra tau=2  tmp=0.5                                | 0.474        | 4    | 8
A1 dijkstra tau=5  tmp=0.5                                | 0.474        | 4    | 8
A1 dijkstra tau=10 tmp=0.5                                | 0.482        | 5    | 8
A2 bfs anchor=idf alpha=0.5                               | 0.434        | 5    | 9
A2 bfs anchor=idf alpha=0.7                               | 0.447        | 4    | 7
A2 bfs anchor=idf alpha=1.0                               | 0.461        | 4    | 7
A2 dijkstra tmp=0.5 anchor=idf alpha=0.3..1.0             | 0.333–0.382  | 3–5  | 7–10
A3 bfs probe=intersection                                 | 0.526        | 5    | 5
A3 bfs probe=weighted-fusion tau=0.2                      | 0.548        | 5    | 3
A3 bfs probe=weighted-fusion tau=0.3                      | 0.496        | 4    | 3
A3 dijkstra tmp=0.5 probe=intersection                    | 0.412        | 4    | 8
A3 dijkstra tmp=0.5 probe=weighted-fusion tau=0.2         | 0.452        | 5    | 7
A2+A3 dijkstra anchor=idf a=0.5 probe=intersection        | 0.333        | 5    | 10
A2+A3 dijkstra anchor=idf a=0.7 probe=intersection        | 0.360        | 4    | 8
A2+A3 dijkstra anchor=idf a=0.5 fusion tau=0.2            | 0.452        | 5    | 7
A1+A2 / A1+A3 / A1+A2+A3                                  | 0.395–0.443 | 4–5 | 8–9
```

Baseline (flat vector search) on tier-2: mean F1 0.544.

Eval (B) on tier-2 — 4 conversation arcs, all promoted configs
including BFS default, A2 (α=0.7 and 0.8), A2+A3 intersection, A3
weighted-fusion (τ=0.2, 0.3), A3 intersection alone:

```
config                                    | narrowed | coherent
everything tested                         | 4/4      | 0/4
```

**Findings:**

1. **A2 does NOT generalize to tier-2.** Tier-1's +0.102 F1 lift
   from graph-informed anchor scoring is absent at tier-2. Every
   A2 configuration regresses mean F1 (0.333–0.461 vs BFS's 0.526).
   Combined with Dijkstra, the regression deepens (worst: 0.333 at
   α=0.5). **A2 was an artifact of tier-1's `alex`-dominant
   tokenization** — when a single ubiquitous token is driving
   anchor pollution, reranking by IDF-mass is a targeted fix; when
   no such token exists and the IDF distribution is spread across
   many moderately-frequent names (Alexander, Sparta, Athens,
   Socrates, Plato, Persian), IDF-mass reranking pushes the wrong
   anchors up — high-IDF rare claims beat legitimately-salient
   common claims on every query that needs the latter.

2. **Dijkstra regresses at tier-2 too.** Lost ~0.11 F1 from BFS.
   Consistent with Phase 1.5's tier-1 observation (best Dijkstra
   was 0.02 below BFS) but deeper here — with 242 claims and
   genuinely diverse clusters, weight-aware traversal finds paths
   that score well on edge-weight but drag in topically-irrelevant
   anchors. No `temporalHopCost` value rescues this on tier-2;
   A1's `temporalDecayTau` also doesn't help (−0.05 to −0.04 F1).

3. **A3 weighted-fusion is the new tier-2 lead** (+0.022 F1 over
   BFS at τ=0.2). Modest but consistent win: 5 wins / 3 losses vs
   BFS's 5/5 split. Intersection gate alone is neutral (identical
   to BFS). Weighted-fusion's additive cross-probe cosine signal
   — discarded on tier-1 as "not sharp enough" — turns out to be
   the right gate when no single anchor dominates: it rewards
   claims that are moderately similar to multiple probes, which
   is exactly the situation tier-2 has.

4. **Eval (B) coherence fails uniformly (0/4) across every
   config.** Root cause is architectural, not tunable within
   Phase 1.6's knob set: session-mode probe accumulation treats
   all turns equally, so broad early-turn probes ("Greek
   philosophy", "Alexander's conquests") keep dominating narrow
   later-turn probes ("Aristotle's pupil", "the Diadochi"). On
   tier-1 this was salvaged by A2+A3 because `alex` anchored every
   turn; on tier-2 the later-turn probes have no shared-token
   lifeline and get drowned out. **Probe-turn weighting or
   session-decay is the next primitive, and it's out of scope for
   Phase 1.6's knob surface.** Narrowing (4/4) still holds —
   candidate counts shrink across turns — so the architecture's
   probe-union behavior is doing *something* right, just not
   enough to land top-K on the current turn's intended claims.

5. **Path retriever's genuine wins at tier-2** (high F1 at same
   anchor-top-K, where baseline fails): *Ptolemaic Egypt*
   (cross-cluster: path 1.00 vs base 0.25), *kings of Macedon*
   (1.00 vs 0.67), *Plato's dialogues* (0.67 vs 0.33),
   *tragic playwrights* (0.33 vs 0.00 — baseline completely
   missed), *as-of Academy head in 340 BCE* (1.00 vs 0.00 —
   bitemporal-light shines again). Baseline still wins on
   small-K literal-cue queries (Pythagorean theorem, as-of
   Athenian statesman) — same as tier-1.

### Phase 2 hypothesis status

**Mixed.** The architectural claims hold: path retrieval wins
decisively on as-of and multi-claim-coverage queries, baseline wins
on single-strong-cue queries, and the composite F1 is competitive
(0.548 best vs baseline 0.544). The *tuning* claim from Phase 1.6
does NOT hold: A2 doesn't transfer, and A2+A3 — the tier-1 career-
arc rescuer — is among the worst tier-2 configs. Phase 1.6's
"primitive change lifted F1 substantially" result is now
understood as a corpus-specific one, not a general property of
multi-probe path retrieval.

What tier-2 *adds* to the finding catalog:

- **A3 weighted-fusion** is the first primitive that wins at both
  tiers without regressing the other. On tier-1 it was neutral
  (0.510 F1, 3 wins / 2 losses); on tier-2 it's the leader
  (0.548, 5/3). Suggests weighted-fusion is more robust to corpus
  shape than A2's anchor reranking, even if its tier-1 gain is
  smaller.
- **Eval-B coherence on tier-2 needs a new primitive.** No
  existing Phase-1.6 knob reaches 1/4, let alone 2/4. Probe-turn
  weighting (e.g., decay old-turn probes, or weight by recency in
  the session) is the natural candidate — and notably, it's a
  *retriever* concern, not a graph or store one.
- **Dijkstra/A1 consistently underperform BFS across tiers.** Not
  a single configuration in either tier has them lifting F1 over
  BFS. At this point their practical value is zero; they remain
  useful only as infrastructure for *future* primitive
  experiments (topic-conditional temporal cost, access-informed
  edge weights).

### Phase 2.1 findings — Option E (session decay) + Option F (default flip)

Phase 2.1 landed two coupled changes:

1. **Option E — per-probe session decay.** `Probe` gained optional
   `turnIndex?: number`. `Session` stamps each probe with a turn
   index (one per `addProbeSentences` / `addNaturalQuery` call) and
   resets on `reset()`. `RetrievalOptions.sessionDecayTau?: number`
   enables per-probe weighting
   `w(p) = exp(-(maxTurn - (p.turnIndex ?? maxTurn)) / tau)`.
   Weights apply in three probe-consumption sites:
   - **Intersection**: threshold is half the total probe weight
     (matches the prior `>= ceil(P/2)` count rule when weights are
     uniform).
   - **Weighted-fusion**: per-probe contribution multiplied by
     `weights[pIdx]` before summing.
   - **probeCoverage**: covered probes' weights summed, divided by
     total probe weight.
   Off by default (`sessionDecayTau === undefined`); back-compat
   preserved for one-shot callers that don't set `turnIndex`.
2. **Option F — default composition flip.** `DEFAULTS.probeComposition`
   moved from `"union"` to `"weighted-fusion"` (τ=0.2 unchanged).
   Gives Option E a stable aggregation baseline that already
   respects per-probe contribution arithmetic. Weighted-fusion's
   fallback-to-union when nothing clears τ (defensive empty-result
   guard) is preserved.

Sweep over eval (B), 12 configs, both tiers:

```
tier-1 (38 claims, 3 traces)                                  | narrowed | coherent
bfs union (legacy default)                                    | 3/3      | 2/3
bfs wfusion tau=0.2 (new default)                             | 3/3      | 3/3
bfs wfusion tau=0.2 + decay=2.0 / 1.0 / 0.5 / 0.3 / 0.05      | 3/3      | 3/3
bfs union + decay=1.0                                         | 3/3      | 3/3
bfs intersection + decay=1.0                                  | 3/3      | 3/3
A2 dijkstra a=0.7 + wfusion/intersection + decay=1.0          | 3/3      | 3/3
bfs wfusion tau=0.2 + decay=5.0 (~uniform)                    | 3/3      | 3/3

tier-2 (242 claims, 4 traces)                                 | narrowed | coherent
bfs union (legacy default)                                    | 4/4      | 0/4
bfs wfusion tau=0.2 (new default)                             | 4/4      | 0/4
bfs wfusion tau=0.2 + decay=2.0 / 1.0 / 0.5                   | 4/4      | 0/4
bfs wfusion tau=0.2 + decay=0.3                               | 4/4      | 1/4
bfs union + decay=1.0                                         | 4/4      | 0/4
bfs intersection + decay=1.0                                  | 4/4      | 0/4
A2 dijkstra a=0.7 + wfusion + decay=1.0                       | 4/4      | 0/4
A2 dijkstra a=0.7 + intersection + decay=1.0                  | 4/4      | 1/4
bfs wfusion tau=0.2 + decay=5.0 (~uniform)                    | 4/4      | 0/4
bfs wfusion tau=0.2 + decay=0.05 (latest-only)                | 4/4      | 1/4
```

Eval (A) under the new default (weighted-fusion τ=0.2):

```
tier                 | mean-F1 | wins | losses
tier-1 new default   | 0.510   | 3    | 2
tier-2 new default   | 0.548   | 5    | 3
tier-1 legacy union  | 0.530   | (Phase 1.6)
tier-2 legacy union  | 0.526   | (Phase 2)
```

**Findings:**

1. **The default flip alone fixed tier-1 eval-B.** Legacy union
   default: 2/3 coherent (career arc failed from Phase 1 onward).
   New default: 3/3. Every swept decay value preserves 3/3. The
   tier-1 career-arc "fix" from Phase-1.6's A2+A3 intersection
   is now available at defaults — which is a stronger position for
   the architecture than Phase-1.6 reported. Cost: tier-1 eval-A
   −0.020 F1 (0.530 → 0.510; within noise, not statistically
   distinguishable from the previous baseline).

2. **Tier-2 eval-A confirms Phase-2's leader as the right default.**
   New default lands 0.548 mean F1 (+0.022 over legacy 0.526) at
   5 wins / 3 losses. This closes the tier-2 "defaults are
   suboptimal" Phase-2 finding.

3. **Session decay helped tier-2 eval-B from 0/4 to 1/4 — but does
   NOT meet Option E's ≥ 2/4 pass criterion.** Best decay configs
   (τ=0.3 or τ=0.05) converge the *Academy arc* only. The three
   cross-cluster arcs (philosophers → Alexander, Athens at war,
   Alexander succession) still miss their late-turn targets
   regardless of how aggressively we down-weight early probes —
   even at τ→0 ("latest-turn-only") the result is 1/4, not 2/4.

4. **Dijkstra + decay pulls back slightly on tier-2 intersection
   mode** (1/4 coherent at A2 α=0.7 + intersection + decay=1.0) —
   intersection benefits from decay on tier-2 where it was harmful
   at Phase 1.6 without decay. Suggests decay and intersection
   interact, but not enough to change recommendations.

5. **Sanity check configs line up.** τ=5.0 (~uniform) reproduces
   the no-decay baseline (0/4), and τ=0.05 (~latest-only) matches
   τ=0.3 at 1/4. The decay arithmetic is mathematically correct;
   the remaining gap is not a tuning problem.

### Phase 2.1 hypothesis status — why 1/4 and not 2/4?

Inspecting the three still-failing tier-2 arcs under τ=0.3:

- *philosophers → Alexander*, turn 3 expected
  `phil_aristotle_tutors_alexander`; actual top-3 =
  `phil_aristotle_leaves_academy`, `phil_theophrastus_lyceum`,
  `phil_aristotle_academy_joins`. The anchor cloud around
  "Aristotle" picks up adjacent-career claims but not the specific
  Alexander-tutoring claim, which lives on the boundary of the
  philosophy and Alexander clusters.
- *Athens at war*, turn 4 expected
  `pwar_aegospotami`/`pwar_athens_surrenders`/`pwar_long_walls_demolished`;
  actual top-3 =
  `pwar_athens_surrenders`, `phil_socrates_delium`,
  `pwar_peace_nicias`. One of three expected hits, but decay pulled
  in a Socrates claim (semantically close to "defeat" via negative
  framing) while the other two expected claims are outscored by
  `pwar_peace_nicias` — a middle-of-the-war claim that the
  late-turn probe "end of the Peloponnesian War" aligns with only
  because of the word "Peloponnesian" alone.
- *Alexander succession*, turn 3 expected Ptolemy / Seleucus /
  Cassander; actual top-3 = `diad_wars_begin`,
  `diad_babylon_partition`, `pw_herodotus_chronicle`. Decay
  correctly moved the top-3 into the `diad_` cluster at turn 3 —
  but the specific generals who *founded kingdoms* lose to
  more-abstract `diad_*` events that share more tokens with the
  probe.

Pattern: **decay fixes session accumulation, but the remaining
failure mode is anchor-cloud displacement** — late-turn probes land
their top-K anchors in the *topically-correct* region but on
*adjacent* claims rather than the expected ones. The expected
claims are typically more specific (named persons, specific
events) while the retrieved ones are more abstract or more
token-overlapping. The retriever selects by raw cosine on the
probe, so any lexically-dense abstract claim outscores the
specific target.

**Next primitive candidate** (post-Phase-2.1): anchor-boost by
*late-turn cosine density* — rerank anchors so that claims which
are close to *any* late-turn probe (not just the highest) gain
priority. Conceptually: the current anchor scoring uses `max_p
cos(p, claim)`; replace with `sum_p w(p) · max(0, cos(p, claim) - τ)`
so a specific named claim that clears τ against two late-turn probes
beats an abstract claim that just barely clears τ against one.
This is an anchor-scoring primitive (the A2 slot) conditioned on
probe weights (the E slot), not a new option. Likely slot:
`anchorScoring: { kind: "weighted-probe-density", tau, probeWeights }`.

### Phase 2.2 findings — Option I (weighted-probe-density anchor scoring)

Phase 2.2 landed Option I as a new `AnchorScoring` variant:

```ts
AnchorScoring =
    | { kind: "cosine" }
    | { kind: "cosine-idf-mass"; alpha: number }
    | { kind: "weighted-probe-density"; tau: number; useSessionWeights?: boolean };
```

When active, the retriever bypasses per-probe top-K ranking and scores every
valid claim globally by `Σ_p w(p) · max(0, cos(p, c) − τ)`, taking the top-K of
that aggregate as the single anchor set. `useSessionWeights` defaults to `true`
(couples to `sessionDecayTau`); `probeComposition` is a no-op when Option I is
active (density already fuses the probes). Defensive fallback to the union
branch preserves non-empty results when τ excludes every claim.

Sweep over eval (A), both tiers:

```
tier-1 (38 claims, 12 queries)             | mean-F1 | wins | losses
bfs wfusion tau=0.2 (Phase 2.1 default)    | 0.510   | 3    | 2
I bfs tau=0.2                              | 0.510   | 3    | 2
I bfs tau=0.3                              | 0.489   | 2    | 2
I bfs tau=0.4                              | 0.489   | 2    | 2
I dijkstra tmp=0.5 tau=0.3                 | 0.468   | 4    | 3

tier-2 (242 claims, 19 queries)            | mean-F1 | wins | losses
bfs wfusion tau=0.2 (Phase 2.1 default)    | 0.548   | 5    | 3
I bfs tau=0.2                              | 0.548   | 5    | 3
I bfs tau=0.3                              | 0.496   | 4    | 3
I bfs tau=0.4                              | 0.465   | 3    | 3
I dijkstra tmp=0.5 tau=0.3                 | 0.417   | 4    | 7
```

Sweep over eval (B), 13-config matrix including a wider τ∈{0.05, 0.1, 0.15,
0.2, 0.25, 0.3, 0.35, 0.4, 0.5} × decay∈{off, 0.05, 0.3, 0.5, 1.0} exploration:

```
tier-1 (3 arcs)                            | narrowed | coherent
bfs union (legacy)                         | 3/3      | 2/3
bfs wfusion tau=0.2 (Phase 2.1)            | 3/3      | 3/3
bfs wfusion tau=0.2 + decay=0.3            | 3/3      | 3/3
every Option I config (tau=0.05..0.5)      | 3/3      | 3/3

tier-2 (4 arcs)                            | narrowed | coherent
bfs union (legacy)                         | 4/4      | 0/4
bfs wfusion tau=0.2 (Phase 2.1)            | 4/4      | 0/4
bfs wfusion tau=0.2 + decay=0.3            | 4/4      | 1/4
I tau=0.05..0.3 + decay=0.3                | 4/4      | 1/4
I tau≥0.35 + decay=0.3                     | 4/4      | 0/4
I tau=0.3 + decay=1.0 or no decay          | 4/4      | 0/4
I tau=0.3 useSessionWeights=false          | 4/4      | 0/4
I tau=0.3 + decay=0.3 on dijkstra          | 4/4      | 1/4
```

**Findings:**

1. **Option I τ=0.2 is behaviorally identical to the Phase-2.1 weighted-fusion
   default.** Mean F1 matches to three decimals on both tiers (0.510 / 0.548)
   and eval-B matches exactly. The formula Option I applies is the same one
   weighted-fusion already runs inside `composeAnchors`; promoting it to the
   A2 anchor-scoring slot decouples the knob but does not introduce a new
   ranking signal. Expected analytically; confirmed empirically.

2. **τ tuning above 0.2 regresses on both tiers.** τ=0.3 drops tier-1 by −0.021
   F1 and tier-2 by −0.052; τ=0.4 compounds the loss. The "more selective
   density" intuition (only strongly-aligned probes contribute) prunes
   legitimate anchors on eval-A queries where the probe cosines sit in the
   0.2–0.35 band.

3. **Eval-B ceiling on tier-2 is unmoved.** Best Option I config reaches 1/4
   coherent — identical to Phase-2.1's best (Academy arc converges; three
   cross-cluster arcs still miss). The `useSessionWeights=false` isolation row
   reaches 0/4, confirming Option I's 1/4 is inherited from decay, not new
   density-only signal. τ∈{0.05, 0.1, 0.15, 0.25} all land at 1/4; τ≥0.35
   collapses back to 0/4.

4. **Anchor-cloud displacement is not a density-aggregate problem.** The
   failure inspection from Phase 2.1 pointed at abstract claims that clear τ
   strongly on one late-turn probe outranking specific claims that clear τ
   moderately on multiple. A *linear sum* aggregate — which Option I is —
   cannot reverse that preference whenever the abstract claim's
   single-probe contribution exceeds the specific claim's sum: with abstract
   peak ≈0.6 and specific ≈0.35 the math is `(0.6−τ) > k·(0.35−τ)` for any
   k achievable at tier-2's probe count × τ combinations. Reversing the
   ranking needs a *non-linear* reward for probe coverage (e.g., count-based
   with a `k² ` or `log(1+k)` bonus, or a minimum-cosine-across-probes gate).

5. **Dijkstra still regresses with Option I anchors.** Phase 1.6's conjecture
   that Dijkstra needs higher-IDF anchors was isolated to tier-1's `alex`
   pollution. With Option I anchors, tier-1 F1 drops to 0.468 and tier-2 to
   0.417. No configuration in this sweep has Dijkstra exceeding BFS; that
   primitive remains inert as a default-shipping option.

### Phase 2.2 hypothesis status

**Refuted**, as the decision gate's "1/4 tier-2 again" branch. Option I ships
as opt-in infrastructure but is not promoted to default (τ=0.2 matches
Phase-2.1's default exactly; higher τ regresses on eval-A). The negative
result refines the Phase-2.1 finding: anchor-cloud displacement on tier-2
is not solvable by reshaping *how* probe contributions aggregate linearly —
it needs either a non-linear coverage reward or a different signal
altogether (topic-conditional edge weights, per-cluster anchor budgets).

### Phase 2.3 findings — Option J (non-linear probe-coverage anchor scoring)

Phase 2.3 landed two new `AnchorScoring` variants designed to flip the
Phase-2.1/2.2 ranking pathology (abstract single-probe-strong claims
outranking specific multi-probe-moderate claims):

```ts
AnchorScoring =
    | { kind: "cosine" }
    | { kind: "cosine-idf-mass"; alpha: number }
    | { kind: "weighted-probe-density"; tau: number; useSessionWeights?: boolean }
    | { kind: "density-coverage-bonus"; tau: number; exponent: number; useSessionWeights?: boolean }
    | { kind: "min-cosine-gate"; tau: number; useSessionWeights?: boolean };
```

- **density-coverage-bonus**: `score(c) = Σ_p w(p)·max(0, cos − τ) · k^(exp − 1)`
  where `k = |{p : cos > τ}|`. At `exp=1` it collapses to Option I
  exactly — useful isolation.
- **min-cosine-gate**: hard `k = P` gate — only claims clearing `τ`
  against every probe contribute; score = min weighted per-probe term,
  tie-broken by sum.

Both honor `useSessionWeights?: boolean` (default `true`), short-circuit
`probeComposition`, and defensively fall through to union when nothing
clears.

Sweep over eval (A), both tiers:

```
tier-1 (38 claims, 12 queries)             | mean-F1 | wins | losses
bfs wfusion tau=0.2 (Phase 2.1 default)    | 0.510   | 3    | 2
J bfs cov-bonus exp=2 tau=0.2              | 0.489   | 2    | 2
J bfs cov-bonus exp=2 tau=0.3              | 0.489   | 2    | 2
J bfs min-gate tau=0.1                     | 0.510   | 3    | 3
J bfs min-gate tau=0.2                     | 0.510   | 3    | 3

tier-2 (242 claims, 19 queries)            | mean-F1 | wins | losses
bfs wfusion tau=0.2 (Phase 2.1 default)    | 0.548   | 5    | 3
J bfs cov-bonus exp=2 tau=0.2              | 0.548   | 5    | 3
J bfs cov-bonus exp=2 tau=0.3              | 0.548   | 5    | 3
J bfs min-gate tau=0.1                     | 0.469   | 4    | 6
J bfs min-gate tau=0.2                     | 0.469   | 4    | 6
```

Sweep over eval (B), 12-config matrix (including exponent sweep, decay
isolation, session-weight isolation, Dijkstra pairing):

```
tier-1 (3 arcs)                                    | narrowed | coherent
bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)   | 3/3      | 3/3
J cov-bonus exp∈{1.5, 2, 3} tau=0.2 + decay=0.3    | 3/3      | 3/3
J cov-bonus exp=2 tau=0.3 + decay=0.3              | 3/3      | 3/3
J cov-bonus exp=2 tau=0.2 no decay                 | 3/3      | 3/3
J cov-bonus exp=2 useSessionWeights=false + decay  | 3/3      | 3/3
J cov-bonus exp=2 + decay=0.3 on dijkstra          | 3/3      | 3/3
J min-gate tau=0.1 + decay=0.3                     | 3/3      | 2/3
J min-gate tau=0.2 + decay=0.3                     | 3/3      | 2/3

tier-2 (4 arcs)                                    | narrowed | coherent
bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)   | 4/4      | 1/4
J cov-bonus exp∈{1.5, 2, 3} tau=0.2 + decay=0.3    | 4/4      | 1/4
J cov-bonus exp=2 tau=0.3 + decay=0.3              | 4/4      | 1/4
J cov-bonus exp=2 tau=0.2 no decay                 | 4/4      | 0/4
J cov-bonus exp=2 useSessionWeights=false + decay  | 4/4      | 0/4
J cov-bonus exp=2 + decay=0.3 on dijkstra          | 4/4      | 1/4
J min-gate tau=0.1 + decay=0.3                     | 4/4      | 0/4
J min-gate tau=0.2 + decay=0.3                     | 4/4      | 0/4
```

**Findings:**

1. **Cov-bonus does NOT lift tier-2 eval-B beyond Phase-2.1's 1/4.** The
   super-linear reward on probe-coverage spread was hypothesized to
   flip abstract-single-probe vs. specific-multi-probe rankings. It
   doesn't: `exp=1.5`, `exp=2`, and `exp=3` all converge the same
   single arc (Academy). Sharper exponents neither lift nor regress —
   suggesting the failures of the three other arcs (*philosophers →
   Alexander*, *Athens at war*, *Alexander succession*) are not
   "strong-peak vs. moderate-spread" events at all. The Phase-2.1
   failure-mode analysis mis-identified the pathology.

2. **The 1/4 that cov-bonus achieves is inherited from decay, not
   from coverage-bonus.** The isolation rows prove it:
   `no decay` → 0/4, `useSessionWeights=false + decay=0.3` → 0/4. Any
   coherence gain comes through `probeCoverage`'s weighted sum in the
   score breakdown, not through the anchor-scorer. Same pattern as
   Option I in Phase 2.2.

3. **Cov-bonus preserves tier-1 3/3 and tier-2 eval-A 0.548.** Unlike
   Option I τ>0.2 (which regressed eval-A −0.05 on tier-2), the
   coverage-bonus keeps the Phase-2.1 default's anchor ranking intact
   at τ=0.2 or τ=0.3 — it scales the aggregate but does not shrink
   the candidate set, so queries with legitimate single-probe-strong
   answers still rank correctly. Tier-1 eval-A dips to 0.489 (−0.021
   from default); the drop comes from queries where J's `k`-scaling
   inverts a justified strong-cosine ranking.

4. **Min-gate regresses everything.** Tier-1 eval-A 0.510 preserved
   but eval-B drops to 2/3 (career arc breaks again); tier-2 eval-A
   drops to 0.469 (−0.079) and eval-B to 0/4. The hard `k=P` gate is
   too strict for a corpus with genuine single-cluster queries
   (marriage-and-Sam, Pythagorean theorem, as-of-Athenian-statesman) —
   the defensive union fallback triggers often enough that the effective
   behavior is "sometimes gate, sometimes union" with the union cases
   driven by noise.

5. **Dijkstra + cov-bonus is inert (same 1/4).** The Phase-1.6
   conjecture that Dijkstra needs higher-quality anchors is fully
   dead: every anchor primitive tried (A2 IDF-mass, Option I density,
   J cov-bonus) leaves Dijkstra at or below BFS. The weighted
   traversal remains opt-in infrastructure with no promotion path
   inside this experiment.

### Phase 2.3 hypothesis status

**Refuted.** Neither J variant meets the ≥2/4 tier-2 eval-B pass bar.
Cov-bonus ships as opt-in infrastructure (matches Phase-2.1 default on
tier-2 eval-A, passes tier-1 eval-B, harmless); min-gate ships as
opt-in infrastructure with a documented warning that it regresses on
corpora with single-cluster queries.

What Phase 2.3 **adds to the finding catalog** (the negative results
are informative):

- **The "anchor-cloud displacement" failure mode is mis-characterized
  at the cosine/coverage level.** Three tier-2 arcs fail at turn 3 or
  4 regardless of whether we reward spread (Option I / J cov-bonus),
  require spread (J min-gate), or decay early probes (Phase-2.1 E).
  Whatever's wrong with these arcs is not solvable by reshaping the
  aggregate `cos × w × coverage` function. The Phase-2.1 failure
  inspection identified specific vs. abstract claims, but the
  exponent sweep (`k^(exp−1)` for `exp ∈ {1.5, 2, 3}`) shows that even
  `k² ` and `k³` bonuses cannot surface the expected claims.

- **All three still-failing arcs have cross-cluster expected answers.**
  *Philosophers → Alexander* (tutor claim spans philosophy + Macedon
  clusters), *Athens at war* (late-war claims tied to specific
  battles, not the general cluster terms), *Alexander succession*
  (named generals vs. abstract Diadochi events). The common thread is
  a **cluster boundary** — the expected claims sit on the edge of two
  topical regions, and none of the cosine-based primitives gives them
  structural priority over interior-cluster claims. **This is a graph
  problem, not a scoring problem.**

- **Coverage-bonus preserves eval-A on tier-2 in a way Option I could
  not.** The key shape: J's `k^(exp-1)` multiplier kicks in only for
  multi-probe coverage (`k ≥ 2`), so single-strong queries ride the
  same anchor ranking as Option I τ=0 (raw sum). This is the first
  anchor primitive that lifts multi-probe queries without penalizing
  single-probe ones. If a future corpus shape rewards multi-probe
  coverage, J cov-bonus is the tool — but tier-2 doesn't.

### Phase 2.4 findings — Option H (cluster-affinity-boost)

**Hypothesis (carried in from Phase 2.3):** the three still-failing
tier-2 eval-B arcs plateau at 1/4 because their expected answers sit
on **topical cluster boundaries** the current embedding + IDF-weighted
lexical edges do not privilege. Adding a cluster-affinity signal to
the anchor-scoring aggregate should promote bridge claims when the
probe set itself spans multiple clusters.

**Primitive shipped:** `AnchorScoring.kind = "cluster-affinity-boost"`
with parameters `tau`, `beta`, `k`, `temperature?`, `seed?`,
`useSessionWeights?`. Formula:

```
score(c) = Σ_p w(p) · max(0, cos(p, c) − τ)       // base = Option I
        × (1 + β · max_p cos(probeClusters(p), claimClusters(c)))
```

Soft-cluster membership from seeded cosine-based k-means++ over the
valid-claim embedding set (`src/clusters.ts`), softmax with
`temperature` over per-centroid cosines. Multiplicative form means
`cosAgg = 0` claims stay out; `beta = 0` collapses to Option I
exactly. Clusters are recomputed on every retrieve that uses the
kind (cheap at 242 claims; cacheable later).

**Sweep:** 9 rows on `iterative-sweep.ts`, k ∈ {4, 6, 8, 10}, β ∈
{0.5, 1.0, 2.0}, all paired with `sessionDecayTau = 0.3` for
apples-to-apples with the Phase-2.1-best row. Plus a β=0 isolation
row.

**Outcome (refuted on pass criterion):**

```
tier-2 eval-B coherence (threshold = 0.5 · expected.size in top-@K):
  Phase-2.1 best (decay=0.3)           1/4     (target)
  H k=4  β=1.0                          1/4
  H k=6  β=0.5                          1/4
  H k=6  β=1.0                          1/4
  H k=6  β=2.0                          1/4
  H k=8  β=0.5                          1/4
  H k=8  β=1.0                          1/4
  H k=8  β=2.0                          1/4
  H k=10 β=1.0                          0/4  (under-clustering hurts)
  H k=8  β=0   (isolation → Option I)   1/4

tier-1 eval-B coherence: 3/3 preserved at every H config (including
k=10). Tier-1 primitive is robust; tier-2 is the gap.
```

Isolation row matches Phase-2.1 best exactly, confirming H's base
aggregation is correct. The β=0 → Option I collapse property is also
verified in `tests/retriever.test.ts`.

**H is not inert** — anchor composition changes under β>0 (verified
by per-turn top-5 diagnostic against Phase-2.1 best). Changes are
mostly neutral: on Athens turn 1 and Alexander-succession turn 2, H
drops one expected claim (hits 1→0 / 2→1), while no failing arc's
critical turn gains a missing expected claim. Net coherence is
unchanged.

**Second reframing (Phase-2.3's cross-cluster story was imprecise):**
Per-turn top-5 inspection under H vs. Phase-2.1 best shows the three
still-failing arcs decompose into **three distinct failure modes**,
not a single cross-cluster story:

1. **Alexander succession turn 3** — vocabulary distractor.
   Expected: `diad_ptolemy_egypt`, `diad_seleucus_babylon`,
   `diad_cassander_macedon`. Actual top-5: `diad_wars_begin`,
   `diad_babylon_partition`, `pw_herodotus_chronicle`,
   `pw_plataea_victory`, `pw_pausanias_commands`. The intruders are
   Persian-Wars-era claims matching the token *"generals"* and
   *"founded"* generically. Cluster-affinity can't help because the
   probes cluster in alex/diad space but the intruders cluster with
   them too (shared "general" vocabulary bakes into the embedding).
   This is a **claim-specificity problem**, not a cluster-boundary
   problem.

2. **Academy arc turn 3** — required claim outside the candidate
   set. Expected: `phil_plato_republic`, `phil_plato_symposium`,
   `phil_plato_forms`. Under both Phase-2.1 best and H,
   `phil_plato_forms` is never in top-5. The probes ("Plato's most
   important writings" / "Plato's dialogues and theories") should
   embed close to `phil_plato_forms` ("Plato developed the theory of
   Forms") but they do not. This is an **embedding/alignment
   problem**, not a scoring-aggregate problem — no anchor-scoring
   reshape can surface a claim whose raw cosine rank is outside
   top-K.

3. **Athens at war turn 4** — within-cluster miss on specific late
   events. Expected: `pwar_aegospotami`, `pwar_athens_surrenders`,
   `pwar_long_walls_demolished`. Top-3 captures
   `pwar_athens_surrenders` only. The missing events cluster
   identically with the probed subject (all late Peloponnesian War,
   all `pwar_` cluster) — cluster-affinity is **inert by design**
   here (the boost factor is ≈1 for both intruders and targets).
   This one is also a **claim-specificity / embedding-granularity
   problem**.

All three failures are now traceable to claim-level problems:
distractor vocabulary, embedding misalignment, or within-cluster
granularity. **None are cross-cluster bridge problems** that
cluster-affinity could solve. Phase-2.3's reframing correctly
identified that aggregate-shape can't fix it; Phase-2.4 sharpens
that further — *cluster geometry can't fix it either*.

### Phase 2.4 hypothesis status

**Refuted.** Option H's cluster-affinity-boost preserves tier-1 at
3/3 and tier-1 anchor behavior, but does not lift tier-2 eval-B
beyond 1/4 at any swept `(k, β)`. The hypothesis that cross-cluster
expected answers are the dominant tier-2 failure mode is itself
refuted by per-turn diagnostic: the three failing arcs have
within-cluster or vocabulary-driven failures, not cluster-boundary
failures.

**Implication for next session:** retire sketch #2 (edge-weight
Dijkstra cluster-agreement rescaling) — it addresses the same
(now-refuted) cross-cluster story. The new candidate directions
target claim-specificity and embedding-alignment:

- **Option L (new) — expand anchor candidate set.** Raise
  `anchorTopK` from 5 to 10 (or 15) and see if `phil_plato_forms`
  enters. Cheap, no new code. Accepts more distractor paths for
  more coverage; scoring + length-penalty should still rank a
  coherent multi-probe path above distractors.
- **Option M (new) — claim-level IDF mass on anchors, not edges.**
  A2 (`cosine-idf-mass`) applied per anchor, not per edge, would
  penalize generic-vocabulary claims like `pw_pausanias_commands`
  when scoring against "generals who kept parts". Already has
  infrastructure — extend the sweep to tier-2 with α ∈ {0.5, 1.0}.
- **Option N (new) — per-probe IDF filtering.** Probes carry
  tokens; token-IDF-weighted probe embedding would downweight
  high-frequency words like "generals" that drag intruders in.

Option K (probe-conditional anchor fusion) retained as backup.
Option G (tier-3 now, accept 1/4) now stronger — if
claim-specificity / embedding-granularity is the remaining gap, it
will be ≥10× worse at 5000-claim Wikipedia scale regardless of any
tier-2 fix, and the corpus shift itself may mask or reveal the
signal.

### Phase 2.5 findings — Option L (expand anchor candidate set)

**Hypothesis (restated).** The Academy-arc turn-3 miss is a
*candidate-set-size* problem: `phil_plato_forms` never enters the
anchor top-5, so simply widening `anchorTopK` to 10 / 15 / 20
should surface it. Length-penalty + probeCoverage scoring was
assumed strong enough to keep distractor paths from outranking a
coherent multi-probe path.

**Setup.** Six new configs in `eval/iterative-sweep.ts` and two in
`eval/sweep.ts`. No library changes — `anchorTopK` is already a
first-class `RetrievalOptions` field and flows through the sweep
spread. Configs:

iterative-sweep.ts:
- `L wfusion τ=0.2 + decay=0.3 anchorTopK=10 / 15 / 20`
- `L×H k=6 β=1.0 τ=0.2 + decay=0.3 anchorTopK=10 / 15`
- `L×J cov-bonus exp=2 τ=0.2 + decay=0.3 anchorTopK=10`

sweep.ts:
- `L bfs wfusion τ=0.2 anchorTopK=10 / 15`

**Results — eval-B (iterative-sweep, coherent/narrowed, primary
criterion).** All 6 tier-2 L-rows REGRESS or tie the floor; all 6
tier-1 L-rows REGRESS from 3/3 → 2/3.

| config                                                  | tier-1 coh | tier-2 coh |
|---------------------------------------------------------|-----------:|-----------:|
| bfs wfusion τ=0.2 + decay=0.3 (Phase 2.1 best baseline) |      3/3   |      1/4   |
| L wfusion + decay=0.3 anchorTopK=10                     |      2/3   |      1/4   |
| L wfusion + decay=0.3 anchorTopK=15                     |      2/3   |      0/4   |
| L wfusion + decay=0.3 anchorTopK=20                     |      2/3   |      0/4   |
| L×H k=6 β=1.0 anchorTopK=10                             |      2/3   |      1/4   |
| L×H k=6 β=1.0 anchorTopK=15                             |      2/3   |      0/4   |
| L×J cov-bonus anchorTopK=10                             |      2/3   |      1/4   |

**Results — eval-A (sweep, mean-F1 vs. A3 bfs wfusion τ=0.2
Phase-2.1 proxy at 0.510 tier-1 / 0.548 tier-2).**

| config                                     | tier-1 F1 | Δ       | tier-2 F1 | Δ       |
|--------------------------------------------|----------:|--------:|----------:|--------:|
| A3 bfs wfusion τ=0.2 (baseline)            |   0.510   |  —      |   0.548   |  —      |
| L bfs wfusion τ=0.2 anchorTopK=10          |   0.472   | −0.038  |   0.399   | −0.149  |
| L bfs wfusion τ=0.2 anchorTopK=15          |   0.483   | −0.027  |   0.368   | −0.180  |

Both eval-A deltas exceed the ±0.02 gate on tier-1 and catastrophically
exceed it on tier-2.

**Key reframing (important).** The anchor-top-K=5 ceiling was
*load-bearing*, not a recall bottleneck. Widening the candidate
set admits more distractor paths than useful anchors; the
downstream path-scoring + length-penalty cannot distinguish them,
so mean-F1 and coherence both collapse. The Phase-2.4 per-turn
diagnostic showed `phil_plato_forms` was absent from top-5; Phase
2.5 shows that *even if the candidate does surface at top-10 /
top-15*, it cannot outrank the additional noise. The failure mode
is **ranking**, not coverage.

**Stacked interpretation across Phase 2.2 → 2.5.**
- Phase 2.2 (Option I / weighted-probe-density): aggregate-shape
  doesn't fix it.
- Phase 2.3 (Option J / coverage-bonus + min-gate): non-linear
  coverage doesn't fix it.
- Phase 2.4 (Option H / cluster-affinity-boost): cluster geometry
  doesn't fix it.
- Phase 2.5 (Option L / expand-candidate-set): more candidates
  *hurt* — the 5-item ceiling was a noise filter.

All four refutations converge on the same conclusion: **tier-2
failures are claim-level**, driven by (a) generic-token distractors
outranking specific claims and (b) within-cluster granularity
differences the embedding geometry doesn't surface. Neither
aggregate-shape, non-linearity, cluster geometry, nor candidate-
set size can fix it from within the current anchor-scoring
pipeline.

### Phase 2.5 hypothesis status

**Refuted** — on all four metrics (tier-1 eval-B, tier-2 eval-B,
tier-1 eval-A, tier-2 eval-A). This is the cleanest refutation of
the Phase-2 arc so far; every lever (including "do less scoring,
give the model more raw candidates") has now been exhausted
without lifting the 1/4 tier-2 eval-B floor.

**Implication for next session:** the remaining tractable option
on the claim-specificity axis is **Option M — per-anchor IDF
mass**. It directly attacks the "generals" distractor (tier-2
failure mode #1) by downweighting generic-vocabulary claims at
anchor-scoring time. The A2 `cosine-idf-mass` infrastructure
already exists at the edge level; the work is wiring per-anchor
IDF into `weighted-probe-density` / `cluster-affinity-boost` and
sweeping α ∈ {0.3, 0.5, 0.7, 1.0} on tier-2.

If Option M also refutes, **Option G (tier-3) becomes the default
next step** — the refutation stack now gives strong evidence that
242-claim tier-2 is near the ceiling of what anchor-scoring
interventions can address. Moving to 5000-claim Wikipedia either
validates tier-2 as a proxy (same primitives degrade at scale) or
reveals a different failure mode that matters more.

### Phase 2.5 delivered

Source: current working tree. Files touched:
- `eval/iterative-sweep.ts` — 6 Option L rows appended (wfusion
  anchorTopK ∈ {10, 15, 20}, H×L at anchorTopK ∈ {10, 15}, J×L at
  anchorTopK=10).
- `eval/sweep.ts` — 2 Option L rows appended (wfusion anchorTopK ∈
  {10, 15}).
- No source or type changes.

547 tests pass (unchanged from pre-Phase-2.5). Typecheck, lint clean.

### Phase 2.6 findings — Option M (idf-weighted-fusion anchor scoring)

**Breakthrough.** First primitive in the Phase-2 arc to genuinely
lift tier-2 eval-B past the 1/4 floor.

**Hypothesis.** The tier-2 failure mode diagnosed in Phase 2.4 (#1:
`pw_pausanias_commands` outranking `diad_seleucus_babylon` on the
probe word "generals") is a **vocabulary-distractor** problem:
generic-token claims win on raw cosine because their common tokens
overlap the probe. A2 `cosine-idf-mass` already addresses this at
the per-probe top-K path, but that path is bypassed whenever any
fusion-style aggregate runs (Option I / J / H / L via the
`weighted-fusion` composition path or the Option-I aggregate
branch). Porting IDF-mass into the aggregate itself should recover
the Phase-1.6 A2 semantics at the anchor-scoring layer used by
Phase-2.1 default.

**Mechanism.** New `AnchorScoring.kind = "idf-weighted-fusion"`:
```
score(c) = (1 + α · normIdf(c)) · Σ_p w(p) · max(0, cos(p,c) − τ)
normIdf(c) = graph.nodeIdfMass(c) / max_{c' ∈ valid} graph.nodeIdfMass(c')
```
Reuses existing `graph.nodeIdfMass` (already wired for A2). α=0
collapses the formula byte-for-byte to Option I (weighted-probe-
density) — its isolation row is the correctness check.

**Setup.** Added `idf-weighted-fusion` variant to `src/types.ts`
and new branch to `src/retriever.ts`'s `composeAnchors` (between
the Option I branch and the `intersection` path). 8 sweep rows in
`eval/iterative-sweep.ts` (α ∈ {0, 0.3, 0.5, 0.7, 1.0, 2.0}, plus
no-decay and useSessionWeights=false isolation rows). 3 rows in
`eval/sweep.ts` (α ∈ {0, 0.5, 1.0}) for eval-A gate. 3 new tests
in `tests/retriever.test.ts`: α=0 isolation, α>0 structural
validity, session-weight toggle.

**Results — eval-B (iterative-sweep, coherent/narrowed, primary
criterion).** Monotonically increasing lift in α, with diminishing
returns past 1.0. Tier-1 holds 3/3 at every α.

| config                                            | tier-1 coh | tier-2 coh |
|---------------------------------------------------|-----------:|-----------:|
| bfs wfusion τ=0.2 + decay=0.3 (Phase 2.1 best)    |     3/3    |     1/4    |
| M idf-fusion τ=0.2 α=0 + decay=0.3 (isolation)    |     3/3    |     1/4    |
| M idf-fusion τ=0.2 α=0.3 + decay=0.3              |     3/3    |  **2/4**   |
| M idf-fusion τ=0.2 α=0.5 + decay=0.3              |     3/3    |  **2/4**   |
| M idf-fusion τ=0.2 α=0.7 + decay=0.3              |     3/3    |  **2/4**   |
| M idf-fusion τ=0.2 α=1.0 + decay=0.3              |     3/3    |  **3/4**   |
| M idf-fusion τ=0.2 α=2.0 + decay=0.3              |     3/3    |  **3/4**   |
| M idf-fusion τ=0.2 α=0.5 no decay                 |     3/3    |  **2/4**   |
| M idf-fusion τ=0.2 α=0.5 useWeights=false + decay |     3/3    |  **2/4**   |

The α=0.5 no-decay row is important: IDF mass alone (without the
Phase-2.1 session-decay signal) still lifts tier-2 to 2/4. The two
mechanisms are independent lift sources; they stack.

**Results — eval-A (sweep, mean-F1 vs. A3 bfs wfusion τ=0.2
baseline: 0.510 tier-1 / 0.548 tier-2).** α=0 matches baseline
byte-for-byte (correctness). α=0.5 is strictly positive on tier-2
and within gate on tier-1. α=1.0 exceeds gate on tier-2.

| config                             | tier-1 F1 | Δ        | tier-2 F1 | Δ        |
|------------------------------------|----------:|---------:|----------:|---------:|
| A3 bfs wfusion τ=0.2 (baseline)    |   0.510   |  —       |   0.548   |  —       |
| M bfs idf-fusion τ=0.2 α=0         |   0.510   |  0.000   |   0.548   |  0.000   |
| M bfs idf-fusion τ=0.2 α=0.5       |   0.517   | **+0.007** |   0.566 | **+0.018** |
| M bfs idf-fusion τ=0.2 α=1.0       |   0.504   | −0.006   |   0.513   | −0.035   |

**α=0.5 is the first Phase-2 primitive that improves on BOTH
axes** (tier-2 eval-B 1/4 → 2/4 AND tier-2 eval-A +0.018) at no
cost to tier-1. α=1.0 demonstrates the tradeoff: bigger tier-2
eval-B lift (2/4 → 3/4) at the cost of a 0.035 tier-2 eval-A
regression — the IDF term over-weights and starts promoting
irrelevant high-IDF anchors into one-shot queries' top-K.

**Key reframing (important).** Four refutations (I/J/H/L) plus
one breakthrough (M) triangulate the actual failure geometry:
- The tier-2 bottleneck is **claim-specificity at the cosine layer**,
  not aggregate shape, coverage non-linearity, cluster geometry, or
  candidate-set size.
- A2 `cosine-idf-mass` solves this on the per-probe top-K path.
  The Phase-2.1 default moved retrieval off that path by using
  weighted-fusion composition; the IDF boost was silently lost in
  the process.
- Option M restores IDF to the aggregate path, unlocking the same
  lift that A2 provided in Phase 1.6 — now compatible with the
  Phase-2.1 defaults.

This is a strong signal that the remaining tier-2 gap (α=0.5: 2/4,
α=1.0: 3/4, never 4/4) is in the third diagnosed failure mode
(Athens-at-war turn 4: within-`pwar_` cluster granularity) — an
embedding-layer limit, not an anchor-scoring one.

### Phase 2.6 hypothesis status

**Confirmed.** Option M passes the primary criterion (tier-2
eval-B ≥ 2/4 at α ≥ 0.3) and, at α=0.5, improves on both eval-A
axes within the ±0.02 gate. α=0 isolation matches Phase-2.1 best
exactly on both tier-1 and tier-2 eval-A — mechanical correctness
is verified.

**Recommended default:** `α=0.5`. Rationale:
- Tier-2 eval-B 2/4 (double the Phase-2.1-best floor).
- Tier-2 eval-A 0.566 (+0.018 over baseline — the first primitive
  in Phase 2 to improve eval-A at all).
- Tier-1 eval-B preserved (3/3). Tier-1 eval-A +0.007.
- α=1.0's larger eval-B lift (3/4) is tempting, but the 0.035
  tier-2 eval-A regression means individual queries get worse
  retrieval. The iterative-arc benefit is paid for by one-shot
  degradation — net-negative in production.

**Implication for next session:** three candidate directions.
1. **Ship α=0.5 as the recommended default in the public API**
   (promote `idf-weighted-fusion` τ=0.2 α=0.5 + decay=0.3 from
   opt-in to default, or document it as "the recommended tier-2
   config"). Update the README retrieval story.
2. **Option G (tier-3 now)** — with M in place, run the 5000-claim
   Wikipedia corpus. Two outcomes:
   - M's lift holds → validates tier-2 as a proxy; M ships.
   - M's lift collapses → reveals whether within-cluster
     granularity (failure mode #3) is what tier-3 exposes at
     scale, which the anchor layer cannot address regardless.
3. **Option M' — α tuning at tier-3.** If tier-3 behaves
   differently, α may need to be re-tuned per-corpus.

### Phase 2.6 delivered

Source: current working tree. Files touched:
- `src/types.ts` — `AnchorScoring` variant `idf-weighted-fusion`
  added after `cluster-affinity-boost`.
- `src/retriever.ts` — new branch in `composeAnchors`, positioned
  after the Option I (`weighted-probe-density`) branch and before
  the `intersection` path. Reuses existing `graph.nodeIdfMass`
  from Phase-1.6 A2.
- `tests/retriever.test.ts` — 3 new tests: α=0 byte-for-byte
  collapse to Option I, α>0 structural validity, session-weight
  toggle.
- `eval/iterative-sweep.ts` — 8 Phase-2.6 rows (α ∈ {0, 0.3, 0.5,
  0.7, 1.0, 2.0}, plus α=0.5 no-decay and useSessionWeights=false
  isolation rows).
- `eval/sweep.ts` — 3 Phase-2.6 rows (α ∈ {0, 0.5, 1.0}) for
  eval-A gate.

84 tests pass (was 81 pre-Phase-2.6). Typecheck, lint, format clean.

### Phase 2.8 — BGE-small full re-sweep + Phase 3 instrumentation

**Motivation.** Phase 2.7 pre-flight swapped the encoder (MiniLM →
BGE-small-en-v1.5) and confirmed the 2/4 narrowing floor was
encoder-layer (lifted to 4/4 universally), but flagged that
Phase-2.6's M α=0.5 primitive tuning was encoder-specific and needed
re-validation. Strategic-review recommendation #1 (embedder upgrade)
was done in 2.7; this phase lands recommendation #2 (Phase 3 access
tracking, observability-only) and executes the full Phase-2-series
re-sweep against BGE-small so the new "best" config is established
before tier-3 sonnet spend.

**Phase 3 instrumentation (landed, observability-only).** Added
node + edge read counters on `GraphIndex`, gated by
`RetrievalOptions.accessTracking` (default `false`). BFS and Dijkstra
traversal bump the counters on node expansion and accepted edge hops.
No scoring path consumes the counters. New API: `bumpNode`,
`bumpEdge`, `nodeReadCount`, `edgeReadCount`, `accessStatsSnapshot`,
`resetAccessStats`. Six new counter tests (3 graph, 3 retriever).
`eval/sweep.ts` and `eval/iterative-sweep.ts` now always set
`accessTracking: true` and emit per-config snapshot totals plus a
top-5-concentration share (`topNodeCount / totalNodeBumps` and
equivalent for edges). 91 smoke-test tests pass (85 → 91).

**Re-sweep headline — eval-A (path F1, top configs):**

| Config | tier-1 | tier-2 |
|---|---|---|
| bfs (default) | 0.647 | 0.561 |
| **dijkstra tmp=0.5** | **0.703** | **0.627** |
| A2 dijkstra tmp=0.5 anchor=idf α∈{0.3..1.0} | 0.703 | 0.627 |
| J bfs min-gate τ∈{0.1, 0.2} | 0.613 | **0.627 (+5 wins / −2)** |
| M bfs idf-fusion τ=0.2 α=0.5 | 0.443 | 0.443 |
| M bfs idf-fusion τ=0.2 α=1.0 | 0.286 | 0.398 |
| L bfs wfusion τ=0.2 anchorTopK=15 | 0.250 | 0.360 |

Dijkstra tmp=0.5 is the universal eval-A winner under BGE-small, tying
with every A2 idf-fusion α on Dijkstra and — on tier-2 only — with J
min-gate. **J min-gate's W/L record (+5/−2) on tier-2 is the best in
the entire sweep**, outpacing Dijkstra's (+4/−2). Strategic-review #3
(prune dead primitives) needs revising: Dijkstra and J min-gate were
both on the MiniLM-era prune list; under BGE-small they are the
top-two eval-A performers. Option L and Option M α ≥ 0.5 are the new
prune candidates — both encoder-stale and both strictly regress.

**Re-sweep headline — eval-B (narrowed / coherent arcs):**

- tier-1: virtually every Phase-2.1+ config hits 3/3 + 3/3. Phase-2.1
  default (`bfs wfusion τ=0.2 + decay=0.3`) is representative.
- tier-2: **narrowing is universal at 4/4**. Coherence ceiling holds
  at 1/4 across every primitive. The Phase-2.1-best row
  (`bfs wfusion τ=0.2 + decay=0.3`) coheres **0/4** under BGE-small
  — session decay is now net-harmful on tier-2 coherence and should
  be turned OFF under the new encoder. Best 1/4 coherent rows on
  tier-2 eval-B:
  - `bfs wfusion τ=0.2` (no decay)
  - `J cov-bonus exp=2 τ=0.2 + decay=0.3 on dijkstra`
  - `M idf-fusion τ=0.2 α∈{0.3, 0.5, 0.7, 1.0} + decay=0.3`
  - `J cov-bonus exp=2 τ=0.2 no decay`

**Phase 3 access-pattern first look.** Access counters are uniformly
flat across both tiers and both eval modes:

- Tier-1 eval-A: top-5 nodes = 16.4% of bumps (uniform baseline:
  5/33 = 15.2%); top-5 edges = 4-7% of bumps.
- Tier-2 eval-A: top-5 nodes = 2.3% (uniform baseline: 5/236 =
  2.1%); top-5 edges = 1.0-1.3%.
- Tier-2 eval-B (multi-turn traces): same shape — 2.3% node top-5,
  1.1-1.5% edge top-5.
- Distinct nodes bumped = total valid-claim count almost exactly
  (236 of 236 bumpable on tier-2). Every valid claim is visited
  every config.

**Translation.** At this corpus scale and with synthetic query
/ trace sets of this shape, *no well-worn paths emerge naturally*.
Access is near-uniform. The "well-worn paths become indexed
shortcuts" premise of Phases 4-5 is under-supported by the first
empirical evidence: path-memory as currently built visits
near-every node on near-every query. Either the corpus shape is
wrong (scattered queries don't model a user's repeat-access
pattern) or the BFS/Dijkstra traversal is too exhaustive to
produce concentration at this `bfsMaxDepth = 3` budget. Phase 4
will need to design against this: either explicit query-history
path caching (artificial concentration via a retrieval cache
layer) or a corpus/evaluation shape that surfaces natural
concentration (repeat-user session logs, not a 19-query scatter).

**Success condition tag: B (eval-A lifts; eval-B coherence ceiling
structural).**

- Eval-A lift is real and reproducible: Dijkstra +0.083-0.193 over
  BFS baseline depending on tier.
- Eval-B coherence ceiling at 1/4 on tier-2 is structural — no
  primitive in the swept matrix moves it; Phase-2.1 decay-on
  tuning actively regressed (2/4 MiniLM → 0/4 BGE-small). The
  coherence gap belongs to Phase 4+ or an embedding-quality step
  (BGE-large, gte-large) not yet scoped. Phase 3 access data
  suggests Phase 4's naïve design ("cache the worn paths") will
  not fire on this corpus shape.

**Shippable default post-BGE-small:** `traversal: "dijkstra",
temporalHopCost: 0.5` (eval-A win). Keep `probeComposition:
"weighted-fusion", weightedFusionTau: 0.2` (the Phase-2.1 default;
equivalent to raw cosine at single-probe, wins on multi-probe).
**Turn session decay OFF** (`sessionDecayTau` undefined) — it now
regresses tier-2 coherence under BGE-small. Keep Option M / H / J
/ L as opt-in infrastructure; do not promote any of them to
default. J min-gate τ=0.1 is a credible alternative on tier-2
with a better W/L record but the Dijkstra row is simpler to
explain and ties on mean F1.

**Tier-3 status.** On hold until a corpus-shape question is
answered: whether the scattered-query tier-3 evaluation will
reproduce the tier-2 0/4 coherence pattern (expected) or whether
the larger disparate-domain corpus triggers a different failure
mode. No sonnet spend until that's framed explicitly.

**Files delivered (Phase 2.8):**
- `src/graph.ts` — access-tracking API (+ types `EdgeAccessKey`,
  `AccessStatsSnapshot`).
- `src/retriever.ts` — `accessTracking` option threaded through
  BFS and Dijkstra; gated bumps at node expansion and accepted
  edge hop.
- `src/types.ts` — `RetrievalOptions.accessTracking`.
- `tests/graph.test.ts` (+3), `tests/retriever.test.ts` (+3).
- `eval/sweep.ts`, `eval/iterative-sweep.ts` — access stats
  threaded through `runConfig` return + stdout.

91 smoke-test tests pass. 548/549 main tests pass (pre-existing
flaky user-domain consolidation test, unrelated). `bun lint`,
`bun typecheck`, `bun format` clean.

### Phase 2.7 pre-flight — embedder upgrade (MiniLM → BGE-small-en-v1.5)

**Motivation.** Strategic review 2026-04-17 (see memory
`path_memory_strategic_review`) flagged `all-MiniLM-L6-v2` (384d,
2021) as the weakest link. Phase 2.6 attributed the eval-B 2/4 floor
to within-cluster embedding granularity — an embedding-layer limit
no anchor-scoring primitive can fix. Before committing sonnet time
to the ~60-article tier-3 split, isolate whether a stronger encoder
lifts the floor.

**Swap.** `BAAI/bge-small-en-v1.5` — BERT-based, 384d, WordPiece
vocab byte-identical to MiniLM (sha256 verified), CLS-pooled. New
`pooling: "mean" | "cls"` config on `OnnxEmbeddingAdapter`. Smoke
test now resolves `.memory-domain/model-bge-small/`; library default
stays MiniLM. MiniLM is preserved side-by-side for A/B.

**Baselines to beat** (Phase 2.6, same corpora):
- eval-A: baseline-bfs 0.544, M α=0.5 0.566.
- eval-B: M α=0.5 converges 2/4 narrowed + 2/4 coherent;
  session-decay τ=0.3 paired — same eval-B, small eval-A lift.

**Success conditions (tag outcome explicitly):**
- **A.** eval-B floor moves (2/4 → 3/4 or 4/4) → encoder was the
  bottleneck; tier-3 validation becomes meaningful.
- **B.** Floor holds at 2/4 but eval-A lifts or at least holds →
  better encoder, same structural ceiling; tier-3 still defensible
  but failure-mode #3 (within-cluster) is the expected result.
- **C.** Metrics regress or hold flat → defer encoder upgrade or
  pick a different encoder; do not spend sonnet budget on tier-3.

**Outcome: split — A on narrowing, C on Phase-2.6 primitive tuning.**

eval-B (tier-2 iterative-sweep, BGE-small + CLS pooling):
- **Narrowing lifted to 4/4 across every config** — the prior 2/4 floor
  was an encoder-layer limit. Architectural win, condition A.
- Coherence held at 0–1/4 across the entire swept matrix. Best rows
  match prior best (1/4), not improved. M α ∈ {0.3, 0.5, 0.7, 1.0}
  + decay=0.3 all converge 1/4 coherent. Phase-2.6's headline
  (M α=0.5 → 2/4 coherent, MiniLM) did **not** replicate; the
  anchor-scoring tuning was encoder-specific.

eval-A (tier-2 sweep, BGE-small + CLS pooling):
- Baseline bfs: 0.561 (MiniLM was 0.544) — small lift.
- **Dijkstra-traversal variants are now the top performers at 0.627**,
  including plain dijkstra tmp=0.5 and every A2 idf-fusion paired with
  dijkstra. Under MiniLM the strategic review had marked Dijkstra
  "inert or harmful" — BGE-small's geometry flips that call.
- M α=0.5 on bfs: 0.443 (MiniLM was 0.566) — **regression**. The
  primitive is encoder-tuned.
- J min-gate τ ∈ {0.1, 0.2}: 0.627, on par with Dijkstra.

**Implications for next session:**
- Do **not** run the ~60-article tier-3 sonnet split on the current
  M α=0.5 config — that tuning is stale.
- The encoder swap is a keep. Narrowing breakthrough (2/4 → 4/4) is
  the strongest single-primitive win in Phase 2; dijkstra lift on
  eval-A is the secondary.
- Before tier-3, re-sweep Phase-2-series primitives against
  BGE-small. Dijkstra-based paths look like the new working default.
  Option M may no longer be net-positive; re-validate at α ∈
  {0.3, 0.5} on Dijkstra rather than BFS.
- Coherence ceiling still at ~1/4 on tier-2 eval-B — BGE-small moved
  narrowing, not coherence. That gap now plausibly belongs to
  recommendation #2 (Phase 3 access tracking → well-worn paths) from
  the strategic review, not anchor-layer primitives.

**Pre-flight delivered:**
- `src/adapters/onnx-embedding.ts` — new `pooling: "mean" | "cls"`
  config; CLS path reads position-0 of sequence dim, then L2-norm.
  Mean-pool path unchanged (MiniLM still default).
- `src/bin/download-model.ts` — `--model {minilm, bge-small}` flag;
  bge-small lands in `.memory-domain/model-bge-small/`.
- `experiments/path-memory-smoketest/src/embedder.ts` — now points
  at the bge-small dir with `pooling: "cls"`.
- `experiments/path-memory-smoketest/tests/embedder.test.ts` — new
  sanity test asserts dissimilar sentences produce cosine < 0.95
  (catches vocab/pooling mismatch).
- `experiments/path-memory-smoketest/tests/eval-iterative-tier2.test.ts`
  — dropped the Phase-2.1 `decayed.coherent > baseline.coherent`
  direction-lock (encoder-specific, now false under BGE-small).
  Narrowing floor is still asserted.

85 smoke-test tests pass. 548/549 main tests pass (one pre-existing
flaky user-domain consolidation test, unrelated).

### Phase 2.4 delivered

Source: current working tree. Files touched:
- `src/clusters.ts` (new) — seeded cosine k-means++ + soft
  membership + membership-similarity. 100% pure function, no
  graph/store dependency. Handles `k > n` (clamps), dead-centroid
  reseed on the point least similar to any existing centroid.
- `src/types.ts` — `AnchorScoring` variant
  `cluster-affinity-boost`.
- `src/retriever.ts` — new branch in `composeAnchors`, positioned
  before Option I; skips k-means entirely when `beta === 0` so the
  β=0 isolation path is no-op on performance.
- `tests/clusters.test.ts` (new) — 11 tests: determinism under
  fixed seed, synthetic 3-cluster recovery, `k > n` clamping,
  `k = 1` base case, rejects empty/zero-k, softmax temperature
  sanity, membership-similarity bridge semantics.
- `tests/retriever.test.ts` — 3 new tests: β=0 collapses to
  Option I byte-for-byte, synthetic 2-cluster + bridge scenario,
  determinism across back-to-back retrieves at fixed seed.
- `eval/iterative-sweep.ts` — 9 Option H rows appended (k ∈
  {4,6,8,10}, β ∈ {0.5,1.0,2.0}, + β=0 isolation).

81 tests pass (was 67 pre-Phase-2.4). Typecheck, lint, format clean.

Does *not* ship in `eval/sweep.ts` (eval-A) rows — Option H
is refuted on the primary criterion (tier-2 eval-B ≥ 2/4); eval-A
numbers would be secondary and adding them would grow the sweep
matrix without changing the conclusion. Can be added later if a
future primitive passes eval-B and we want a back-check on eval-A.

### Phase 2.3 delivered

Source: current working tree. Files touched:
- `src/types.ts` — `AnchorScoring` variants `density-coverage-bonus`
  and `min-cosine-gate`.
- `src/retriever.ts` — two new branches in `composeAnchors`,
  positioned before the Option I block; both reuse `perProbe` cosine
  cache and `probeWeights`, with defensive fall-through to union.
- `tests/retriever.test.ts` — 8 new tests: structural validity,
  ranking-flip vs. Option I at `exp=2`, `exp=1` equivalence to Option
  I, session-weight toggle, high-τ fallback (cov-bonus); gate
  rejection + fallback (min-gate).
- `eval/iterative-sweep.ts` — Phase-2.3 12-config matrix replacing the
  Phase-2.2 matrix.
- `eval/sweep.ts` — four Option J rows appended.

67 tests pass (was 59 pre-Phase-2.3). Typecheck, lint, format clean.

### Phase 2.2 delivered

Source: current working tree. Files touched:
- `src/types.ts` — `AnchorScoring` variant `weighted-probe-density`.
- `src/retriever.ts` — new global-density branch in `composeAnchors` with
  defensive fallback to union.
- `tests/retriever.test.ts` — 5 new tests: structural validity, density
  favors multi-probe overlap over single-probe dominance,
  `useSessionWeights` toggle, short-circuits probeComposition, high-τ
  fallback.
- `eval/iterative-sweep.ts` — Phase-2.2 10-config matrix replacing the
  Phase-2.1 matrix.
- `eval/sweep.ts` — four Option I rows appended.

59 tests pass (was 54 pre-Phase-2.2). Typecheck and lint clean.

### Phase 2.1 delivered

Source: see current working tree. Files touched:
- `src/types.ts` — `Probe.turnIndex?`, `RetrievalOptions.sessionDecayTau?`.
- `src/retriever.ts` — `computeProbeWeights` helper; weighted
  intersection / weighted-fusion / probeCoverage; default flip
  to `"weighted-fusion"`.
- `src/interfaces.ts` — `Session.currentTurn`, per-call turn
  stamping, `turnCount` getter, `reset()` clears it.
- `eval/iterative-sweep.ts` — 12-config Phase-2.1 matrix.
- `tests/retriever.test.ts` — 4 new Phase-2.1 tests.
- `tests/interfaces.test.ts` — Session turn-tracking tests (new file).
- `tests/eval-iterative.test.ts` / `tests/eval-iterative-tier2.test.ts`
  — second assertion pass under `sessionDecayTau: 1.0` / `0.3`.

54 tests pass (was 46 pre-Phase-2.1). Typecheck and lint clean.

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
│   ├── clusters.ts             # seeded k-means++ + soft cluster membership
│   ├── interfaces.ts           # PathMemory + Session facades
│   └── embedder.ts             # ONNX embedder factory (wraps parent adapter)
├── data/
│   ├── tier1-alex.ts           # 38 hand-authored claims
│   └── tier2-greek.ts          # 242 Greek-history claims, 8 clusters
├── eval/
│   ├── baseline.ts             # flat vector-search baseline
│   ├── queries-tier1.ts        # 12 queries with marked ideal answers
│   ├── queries-tier2.ts        # 19 queries, 4 categories
│   ├── conversation-traces-tier1.ts  # 3 multi-turn traces
│   ├── conversation-traces-tier2.ts  # 4 multi-turn traces
│   ├── sweep.ts                # config-sweep over eval (A), TIER env var selects tier-1 / tier-2
│   └── iterative-sweep.ts      # config-sweep over eval (B), TIER env var
└── tests/
    ├── helpers.ts              # deterministic fake embedder + wiring
    ├── embedder.test.ts        # real embedder smoke test
    ├── store.test.ts           # 7 bitemporal invariants
    ├── graph.test.ts           # 13 edge-formation + IDF invariants
    ├── retriever.test.ts       # retrieval behaviors (36 tests post-2.4)
    ├── clusters.test.ts        # k-means + soft membership (11 tests)
    ├── interfaces.test.ts      # Session turn tracking
    ├── eval-vs-baseline.test.ts          # eval (A) tier-1
    ├── eval-vs-baseline-tier2.test.ts    # eval (A) tier-2
    ├── eval-iterative.test.ts            # eval (B) tier-1
    └── eval-iterative-tier2.test.ts      # eval (B) tier-2
```

81 tests pass post-Phase-2.4 (46 → 54 at 2.1 → 59 at 2.2 → 67 at 2.3
→ 81 at 2.4). Typecheck clean.

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

### Phase 1.6 — Option-A primitive revisits — **done, A2 is the win**

See "Phase 1.6 findings" in Part 2. Landed:
- **A1**: `temporalDecayTau` on `GraphConfig` → temporal edge
  `weight = exp(-deltaT / tau)`; Dijkstra reads
  `temporalDecayEnabled()` and uses
  `cost = temporalHopCost · (1 − weight)` when on. Off by default.
- **A2**: `RetrievalOptions.anchorScoring`; `cosine-idf-mass` mode
  reorders anchors by `cosine · (1 + alpha · normalizedNodeIdfMass)`.
  `GraphIndex.nodeIdfMass(id)` exposed. Default `cosine` (off).
- **A3**: `RetrievalOptions.probeComposition` with `intersection` and
  `weighted-fusion` modes (`weightedFusionTau` knob, default 0.2).
  Default `union` (off). Both gates fall back to union when nothing
  passes — defensive against empty results.
- Eval `eval/iterative-sweep.ts` runner for parameterized eval (B).

Outcome: **A2 is the breakthrough.** Best single-knob: A2 Dijkstra
α=0.8 → 0.632 mean F1 (+0.102 over BFS), no eval (B) regression.
Best comprehensive: A2+A3 Dijkstra α=0.7 intersection → 0.596 F1
**and 3/3 coherent arcs** (vs BFS's 2/3). A1 is actively harmful in
every combination; not recommended at this corpus shape. Defaults
unchanged (BFS, raw cosine, union) — promotion to default deferred
to tier-2 validation (see Phase 2).

### Phase 2.1 — Option E + Option F — **done**

See "Phase 2.1 findings" in Part 2. Landed:
- `Probe.turnIndex?` + `RetrievalOptions.sessionDecayTau?`
  (exponential decay by session turn index).
- Weighted intersection threshold, weighted-fusion contribution,
  weighted `probeCoverage`.
- `Session.currentTurn` auto-stamping per add-call; `reset()`
  clears it.
- Default `probeComposition` flipped from `"union"` to
  `"weighted-fusion"` (τ=0.2).

Outcome: **default flip unexpectedly solved tier-1 eval-B** (2/3
→ 3/3) and met tier-2 eval-A (+0.022). Session decay lifted
tier-2 eval-B from 0/4 to 1/4 — below the ≥2/4 pass criterion.
Remaining gap was hypothesized as anchor-cloud displacement;
Option I was the natural test.

### Phase 2.4 — Option H — **done, refuted**

See "Phase 2.4 findings" in Part 2. Landed:
- `src/clusters.ts` (new) — seeded cosine k-means++ with soft
  membership and cosine-based membership similarity; pure-function,
  no graph/store dependency; handles dead-centroid reseed and
  `k > n` clamp.
- `AnchorScoring.kind = "cluster-affinity-boost"` with
  `tau`, `beta`, `k`, `temperature?`, `seed?`, `useSessionWeights?`
  — `cosAgg · (1 + β · max_p clusterAffinity(p, c))` using the soft
  membership vectors. β=0 skips the k-means entirely and collapses
  to Option I.
- Phase-2.4 9-row extension to `iterative-sweep.ts`; 11 new
  cluster-unit tests + 3 retriever tests (β=0 collapse, 2-cluster
  bridge, determinism).

Outcome: **every H config matches tier-1 eval-B at 3/3**; tier-2
eval-B stays at 1/4 across `(k ∈ {4,6,8,10}) × (β ∈ {0.5,1.0,2.0})`.
Diagnostic trace of anchor top-5 under H vs. Phase-2.1 best shows
H *is* reshaping anchor sets but in a neutral-to-slightly-negative
direction. Critically, per-turn inspection refutes the Phase-2.3
"cross-cluster" reframing itself: the three failing arcs decompose
into three *distinct* claim-level failure modes — vocabulary
distractor (`pw_pausanias_commands` matching the token "generals"),
required-claim-outside-top-K (`phil_plato_forms` never in top-5),
and within-cluster-granularity (specific late-Peloponnesian events
fighting each other inside the `pwar_` cluster). None are
cross-cluster bridge problems. Ships as opt-in infrastructure.

### Phase 2.3 — Option J — **done, refuted**

See "Phase 2.3 findings" in Part 2. Landed:
- `AnchorScoring.kind = "density-coverage-bonus"` (`tau`, `exponent`,
  `useSessionWeights?`) — `agg · k^(exp−1)` multiplier on Option I's
  linear sum.
- `AnchorScoring.kind = "min-cosine-gate"` (`tau`, `useSessionWeights?`)
  — hard `k=P` gate with `min` score and sum tie-break.
- Phase-2.3 12-config iterative-sweep matrix; four J rows appended to
  eval-A sweep; 8 new unit tests.

Outcome: **cov-bonus matches Phase-2.1 baselines on every axis
(tier-1 3/3, tier-2 1/4, tier-2 eval-A 0.548 preserved, tier-1 eval-A
dips 0.021)**; does NOT lift tier-2 eval-B beyond 1/4. The isolation
rows (`no decay` → 0/4; `useSessionWeights=false + decay=0.3` → 0/4)
prove the 1/4 is inherited from `probeCoverage`'s decay weighting, not
from the coverage-bonus signal itself. `exp ∈ {1.5, 2, 3}` all converge
the same single arc — sharper non-linearity neither helps nor hurts,
which is strong evidence the failing tier-2 arcs are not
"strong-peak-vs-moderate-spread" events. Min-gate regresses everywhere
(tier-1 eval-B 3/3 → 2/3, tier-2 eval-A −0.079, tier-2 eval-B 1/4 →
0/4) — too strict for a corpus with genuine single-cluster queries.
Both variants ship as opt-in infrastructure; neither promoted to
default. The Phase-2.1 "anchor-cloud displacement" pathology is
**mis-characterized**: the three still-failing arcs all have
cross-cluster expected answers, so the pathology is graph-structural
(cluster boundary handling), not cosine-aggregate shape.

### Phase 2.2 — Option I — **done, refuted**

See "Phase 2.2 findings" in Part 2. Landed:
- `AnchorScoring.kind = "weighted-probe-density"` with `tau` and
  optional `useSessionWeights` (default `true`).
- New branch in `composeAnchors` that computes
  `Σ_p w(p) · max(0, cos(p, c) − τ)` globally and short-circuits
  probeComposition; defensive fall-through to union when τ
  excludes everything.
- 5 new unit tests; Phase-2.2 10-config iterative-sweep matrix;
  four Option I rows added to eval-A sweep.

Outcome: **τ=0.2 is behaviorally identical to the Phase-2.1
default** (same formula, same eval-A/eval-B numbers). Higher τ
regresses eval-A. Tier-2 eval-B ceiling stays at 1/4. Option I
ships as opt-in infrastructure; not promoted to default. The
Phase-2.1 hypothesis that linear density aggregation would fix
anchor-cloud displacement is refuted — reversing
single-probe-strong vs. multi-probe-moderate rankings requires
a non-linear coverage reward (see Option J, below).

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

**Option E — done (Phase 2.1).** Per-probe session decay.
Lifted tier-2 eval-B from 0/4 to 1/4 (best τ=0.3).

**Option F — done (Phase 2.1).** Weighted-fusion τ=0.2 as the
default `probeComposition`. Lifted tier-1 eval-B from 2/3 to 3/3
at defaults.

**Option I — done (Phase 2.2), refuted.** Weighted-probe-density
anchor-scoring. Mathematically identical to the Phase-2.1 default
at τ=0.2; higher τ regresses.

**Option J — done (Phase 2.3), refuted.** Density-coverage-bonus
(`agg · k^(exp−1)`) and min-cosine-gate (`k=P` gate). Cov-bonus
preserves baselines but does not lift tier-2 eval-B past 1/4; the
exponent sweep (1.5 / 2 / 3) is behaviorally flat on coherence.
Min-gate regresses. The "anchor-cloud displacement" pathology
identified in Phase 2.1 is now known to be mis-characterized: the
three still-failing tier-2 arcs are **cross-cluster expected
answers**, not specific-vs-abstract at a fixed cosine band —
re-shaping the per-claim cosine aggregate does not help because
the expected claims themselves sit on topical cluster boundaries
that the embedding + edge weights do not privilege. This is a
graph-structural problem, not a scoring-shape problem.

**Option H — done (Phase 2.4), refuted.** Cluster-affinity-boost
anchor scoring. `score(c) = cosAgg(c) · (1 + β · max_p clusterAffinity(p, c))`
with soft k-means over claim embeddings. Across 9 configs
(k ∈ {4,6,8,10}, β ∈ {0.5,1.0,2.0}) the boost preserves tier-1
eval-B at 3/3 and leaves tier-2 eval-B at 1/4 — same as Phase-2.1
best. β=0 isolation row matches Phase-2.1 best exactly, confirming
mechanical correctness. Per-turn diagnostic refutes the Phase-2.3
"cross-cluster" reframing itself: the three failing arcs have
within-cluster or vocabulary-driven failures (see § Phase 2.4
findings), so cluster geometry was never the bottleneck. Edge-weight
rescaling (sketch #2) is retired for the same reason.

**Option L — done (Phase 2.5), refuted.** Expanded `anchorTopK` to
10 / 15 / 20 (and cross-rows against H and J best-configs). Tier-1
eval-B regressed from 3/3 → 2/3 at every L config; tier-2 eval-B
stayed 1/4 at anchorTopK=10 and regressed to 0/4 at ≥15; tier-1
eval-A dropped by 0.027–0.038; tier-2 eval-A dropped by
0.149–0.180. The anchor-top-K=5 ceiling is load-bearing — the
downstream path scorer cannot distinguish useful candidates from
distractors when the pool widens. The failure mode is **ranking,
not coverage**. (See § Phase 2.5 findings.)

**Option M — done (Phase 2.6), CONFIRMED.** `idf-weighted-fusion`
anchor scoring ports A2 `cosine-idf-mass` semantics into the
fusion aggregate. `score(c) = (1 + α · normIdf(c)) · Σ_p w(p) ·
max(0, cos(p,c) − τ)`. α=0 collapses to Option I byte-for-byte.
Recommended default **α=0.5**: tier-2 eval-B 1/4 → 2/4, tier-2
eval-A +0.018, tier-1 preserved at 3/3 + tier-1 eval-A +0.007 —
first Phase-2 primitive to improve both axes. α=1.0 lifts tier-2
eval-B to 3/4 but regresses tier-2 eval-A by 0.035 (over-weights).
Validates that the tier-2 bottleneck is claim-specificity at the
cosine layer — the Phase-2.1 default silently dropped the A2 IDF
boost by moving retrieval off the per-probe top-K path; Option M
restores it on the aggregate path. (See § Phase 2.6 findings.)

**Option G (now primary) — tier-3 validation of Option M.**
With M in place the question becomes: does the α=0.5 lift hold at
5000-claim Wikipedia scale? Two outcomes shape the next session:
- M's lift holds → validates tier-2 as a proxy; α=0.5 becomes the
  shippable default. Publish the retrieval story.
- M's lift collapses → the within-cluster granularity failure
  mode (tier-2 #3, Athens-at-war turn-4) dominates at scale — an
  embedding-layer limit the anchor layer can't address, and a
  signal to pivot toward Option N (IDF-weighted probe embedding)
  or better embedding models.

**Option N (retained) — per-probe IDF-weighted embedding.**
Probe-side analogue of M. More invasive (requires re-embedding)
but only relevant if Option G reveals that tier-2's anchor-layer
IDF boost does not carry to tier-3.

**Option K (retained as backup) — probe-conditional anchor fusion.**
Score each probe's top-K independently; union only across probes
whose anchor sets share cluster signal. Addresses the
cross-cluster story that Phase 2.4 refuted; only worth trying if a
future arc actually *is* cross-cluster.

### Phase 2.8 update — M refuted under BGE-small; Dijkstra is the new default; Phase 3 access data says well-worn paths do NOT naturally emerge

Post-BGE-small re-sweep (Phase 2.8) replaces the Option G
recommendation above. M α=0.5 regressed to 0.443 on both tier-1 and
tier-2 eval-A (vs MiniLM 0.566); M is **encoder-stale** and does not
ship as a tier-3 candidate. The new facts:

- **New shippable default.** `traversal: "dijkstra", temporalHopCost:
  0.5, probeComposition: "weighted-fusion", weightedFusionTau: 0.2,
  sessionDecayTau: undefined`. Eval-A: 0.703 tier-1 / 0.627 tier-2.
  Eval-B: 4/4 narrowed tier-2 (architectural win from Phase 2.7),
  1/4 coherent tier-2 (ceiling structural). Session decay turned
  OFF — under BGE-small it regresses tier-2 eval-B coherence to 0/4.
- **Alternative on tier-2.** J min-gate τ=0.1 / 0.2 ties Dijkstra on
  mean F1 (0.627) with a better W/L record (+5/−2 vs +4/−2).
  Dijkstra wins on simplicity but J min-gate is defensible.
- **Dead primitives under BGE-small.** Option L (anchorTopK ≥ 10),
  Option M α ≥ 0.5, A1 temporal-decay τ ∈ {2, 5, 10}. These all
  regress eval-A and do not lift eval-B. Strategic-review #3
  (prune dead primitives) applies to these, not to Dijkstra.

**Phase 3 first-look refutes the naïve "well-worn paths" story.**
Access counters are uniformly flat at this corpus scale and
query/trace shape:
- tier-2 eval-A: top-5 node share 2.3% (= uniform 5/236 = 2.1%),
  top-5 edge share 1.0-1.3%.
- tier-2 eval-B 4-turn traces: same flat shape — top-5 edges
  1.1-1.5%.
- Distinct bumped nodes ≈ total valid-claim count (every query
  visits nearly every node at `bfsMaxDepth=3`).

Path-memory as currently built does not surface concentration from
synthetic query scatters. The Phase-4 naïve design ("cache frequently
accessed paths") won't fire on this corpus. Phase 4 now has a
pre-condition question: either (a) generate a corpus/trace shape
where concentration emerges (repeat-user session logs, topic-biased
query streams), or (b) engineer concentration explicitly via a
retrieval-cache layer keyed on probe clusters / query history.
Without that pre-condition, Phase 4 is premature.

### Recommended next session (post-Phase-2.8)

The decision tree has shifted. Two productive directions, both
smaller-scope than a tier-3 corpus build:

1. **Corpus-shape experiment before tier-3.** Design a "repeat-user
   session" eval: ~6-10 multi-turn conversations that revisit the
   same topical cluster (e.g. 3 separate sessions all about
   Peloponnesian War details). Re-run the Phase-2.8 best default
   + Phase 3 instrumentation on this shaped corpus. Test whether
   concentration emerges (top-5 edge share ≫ uniform baseline).
   If yes: Phase 4 design can proceed on real signal. If no: the
   architectural claim itself is under tension, not just the
   tuning.

2. **Encoder upgrade before tier-3.** BGE-large-en-v1.5 (1024d) or
   gte-large-en-v1.5 (1024d). Both deterministic, LLM-free, 3-4×
   bigger than BGE-small. If the tier-2 coherence ceiling is
   within-cluster-granularity (Phase 2.6 diagnosis, still the
   leading hypothesis), a stronger encoder is the only
   architectural move that would lift it without Phase-4
   dependencies.

Either is a 1-session scope. Do (1) first — it's cheaper and
directly answers whether Phase 4 has a target to hit. Tier-3
sonnet spend stays on hold until one of these produces a signal.

Legacy recommendation (pre-Phase-2.8) kept below for historical
context:

Recommendation: **Option G (tier-3 with α=0.5 idf-weighted-fusion
as the candidate shippable default)** — the breakthrough in Phase
2.6 is strong enough to test at scale. Keep the sweep narrow (M
α ∈ {0.3, 0.5, 0.7, 1.0}, plus Phase-2.1-best baseline, plus
vanilla `bfs`) — the tier-3 run is primarily a validation of M,
not a re-opening of the rest of the sweep. If G confirms, draft
the public API migration (promote `idf-weighted-fusion` to default
or recommended tier-2 config). If G refutes, that's the signal to
invest in Option N / embedding upgrades.

---

## Phase 2.9 — eval-C repeat-user corpus-shape experiment (2026-04-17)

**Question.** Phase 3 measured flat access on eval-A synthetic
scatters and eval-B 3-4-turn arcs. Was flatness an *architectural*
property or an *eval-shape* property? This phase answers it under
repeat-user traffic.

**Method.** 8 multi-session traces on tier-2 Greek (242 claims),
each simulating a single user returning across 4-6 sessions that
revisit overlapping cluster neighborhoods. 22-29 turns per trace,
~200 turns total. Retrieval config = Phase-2.8 default (Dijkstra
`tmp=0.5` + weighted-fusion `τ=0.2`, session-decay off).

Per trace: fresh `PathMemory` instance (access counters isolated
per-trace); within a trace, one `memory.createSession()` per
"session" block (probe/decay state resets, graph shared → access
counters accumulate across all sessions of that trace).

Metrics: top-5 node/edge share of bumps, ratio against a uniform
baseline (`5/distinct`), and the count of repeated top-3 path-
node-set signatures across sessions of a trace.

See `eval/traces-repeat-user.ts` and `eval/eval-c-access.ts`.
Pass criterion (from PLAN-post-2.8.md § "Phase 2.9"):
**edgeRatio ≥ 5.0 on ≥ half of traces**.

### Results

| trace                          | sess | turns | distinctN | distinctE | top5NodeShare | nodeRatio | top5EdgeShare | edgeRatio | repeatPaths |
|--------------------------------|------|-------|-----------|-----------|---------------|-----------|---------------|-----------|-------------|
| plato-academy-returning        | 5    | 25    | 233       | 2589      | 0.022         | 1.00      | 0.011         | 5.53      | 0           |
| athens-at-war-returning        | 6    | 26    | 233       | 4651      | 0.022         | 1.00      | 0.011         | 10.28     | 0           |
| alexander-campaigns-returning  | 5    | 25    | 233       | 3566      | 0.022         | 1.01      | 0.010         | 7.35      | 0           |
| diadochi-succession-returning  | 5    | 22    | 233       | 3798      | 0.022         | 1.01      | 0.010         | 7.58      | 0           |
| religion-oracles-returning     | 4    | 23    | 233       | 4252      | 0.022         | 1.02      | 0.009         | 7.72      | 0           |
| theatre-historians-returning   | 5    | 25    | 233       | 4284      | 0.022         | 1.01      | 0.010         | 8.66      | 0           |
| athens-politics-returning      | 5    | 25    | 233       | 3049      | 0.022         | 1.00      | 0.011         | 6.49      | 0           |
| schools-philosophy-returning   | 5    | 29    | 233       | 4064      | 0.022         | 1.01      | 0.010         | 8.16      | 0           |

**Pass count: 8/8 traces with edgeRatio ≥ 5.0. Verdict: PASS.**
Mean ratios across traces: nodeRatio = 1.01, edgeRatio = 7.72.

### Interpretation

The result is more nuanced than a simple "well-worn paths exist":

1. **Nodes are uniformly accessed.** `nodeRatio ≈ 1.00` across every
   trace. The Phase-2.8 finding (top-5 node share ≈ uniform)
   survives the traffic-shape change. Every reachable claim is
   visited roughly equally; Dijkstra + BFS fanout at this graph
   density saturates node coverage.

2. **Edges concentrate sharply.** `edgeRatio = 5.5-10.3×` uniform.
   A small subset of edges (likely temporal-chain spine + a few
   high-weight lexical bridges) carry a disproportionate share of
   traversal bumps. This is the real "well-worn path" signal — but
   it lives at the *edge* level, not the *node* level.

3. **Path-as-returned signatures do not repeat.** Every one of 40
   sessions (5 avg × 8) produced a unique top-3 path-node-set. So
   retrieval *does* surface different final paths to the user even
   when the underlying traversal repeatedly visits the same edges.
   The edge concentration is "common substructure on the way to
   different answers," not "same answer keeps being returned."

### Consequences for Phase 4

The naïve Phase-4 design (PLAN-post-2.8.md § "Phase 4 redesign"
option 1: "cache on `(probe-cluster, session-recency)`") now has a
target — but the target is an **edge-subgraph cache**, not a path
cache. Concretely:

- A per-trace "hot edge set" of 50-200 edges (top ~5% by access
  count) could substantially prune Dijkstra fanout without losing
  coverage — the other 4000+ edges are traversed rarely.
- A path-as-key cache (original Phase-4 shape) would miss
  essentially every lookup — confirmed by `repeatingPaths = 0`
  across every trace.
- The edge concentration is also exactly what Phase-2.10's
  spreading-activation primitive would accumulate into an activation
  profile (§ "Phase 4 redesign" option 2). Option O now has two
  independent motivations: anchor-layer reranker (tier-2 coherence)
  AND persistence substrate for the observed edge concentration.

### Retire from roadmap

- **Path-cache (original Phase 4)** — deprecated; zero hit rate on
  tier-2 repeat-user traces.

### Promote to roadmap

- **Edge-hotness cache (Phase 4 redesign option 1)** — real signal,
  worth pursuing if Phase 2.10 doesn't subsume.
- **Phase 2.10 (Option O) priority ↑** — activation profile is the
  natural substrate for the edge concentration we just measured.

### Limitations

- Tier-2 only. Unknown whether the ratios scale linearly with corpus
  size; tier-3 (which would re-center on a larger graph) is the
  obvious stress test, but PLAN-post-2.8.md already retargets tier-3
  to LongMemEval, so we'll get this measurement for free there.
- Traces are hand-authored to revisit clusters. The ratios would
  presumably be lower under pure topic-switching traffic. That's
  fine — the question was "can concentration emerge", answered yes;
  "is concentration the dominant regime" is a separate question that
  LongMemEval will illuminate.
- `distinctNodes = 233` across all traces (tier2 has 242 claims, 9
  presumably isolated / un-reachable at `bfsMaxDepth=3`). Not
  investigated — not load-bearing for the pass criterion.

## Phase 2.10 — Spreading-activation anchor scorer (Option O) (2026-04-17)

**Outcome: NEGATIVE.** Both eval-A tiers regress; eval-B coherence
unchanged. Per the kill criterion in `PLAN-post-2.8.md` § Phase 2.10,
Option O ships as opt-in infrastructure (new `AnchorScoring` kind
`"spreading-activation"`) but defaults remain at Phase 2.8
(`dijkstra tmp=0.5` + weighted-fusion `τ=0.2`).

### Setup

SYNAPSE-inspired (arXiv:2601.02744v2) — see
`notes/phase-2.10-reading.md` for the reading note. New anchor
scorer seeds activation from per-probe weighted-cosine top-K,
propagates over `GraphIndex.neighbors` for `maxHops` iterations
with fan-effect dilution (`/ neighbors(j).length`), applies
non-symmetric top-`inhibitionTopM` lateral inhibition each hop,
then re-ranks by final activation. **Adopted the paper's
top-M-by-activation lateral inhibition** (cheaper, ablation-validated)
rather than the cosine-pair variant in PLAN-post-2.8.md.

Sweep: 16 primary configs (`initialTopK ∈ {5,8} × maxHops ∈ {2,3} ×
decay ∈ {0.5,0.7} × inhibitionTopM ∈ {5,7}`, fixing `S=0.8, β=0.15`)
+ 5 ablation configs (β ∈ {0, 0.10, 0.25}, S ∈ {0.6, 1.0}). All
rows pinned to `dijkstra tmp=0.5` so movement is attributable to
the new anchor scorer, not the traversal change. K0=5 and K0=8
collapse to identical numbers on both tiers — the seeded set is
already a superset of what propagation/inhibition narrows down to
on a 33-node (tier-1) / 236-node (tier-2) graph.

### Eval-A results

Phase 2.8 baseline (`dijkstra tmp=0.5`): **0.703 tier-1 / 0.627 tier-2**.

Best Option O configs:

| config | tier-1 | tier-2 |
|---|---|---|
| baseline (Phase 2.8) | **0.703** | **0.627** |
| O T=2 δ=0.5 M=7 (β=0.15, S=0.8) | 0.682 | 0.474 |
| O T=3 δ=0.5 M=7 (β=0.15, S=0.8) | 0.682 | 0.453 |
| O central β=0.1 | 0.682 | 0.452 |
| O central S=0.6 | 0.682 | 0.488 |
| O T=2 δ=0.5 M=5 (β=0.15, S=0.8) | 0.661 | 0.485 |
| O central β=0.25 | 0.599 | **0.522** (best tier-2) |
| O central β=0 (no inhibition) | 0.536 | 0.507 |

Best tier-1 config (0.682): regress -0.021 vs baseline (right at the
0.02 threshold, technically a blocker).
Best tier-2 config (0.522): regress -0.105 vs baseline (clear
regression).
**No single config holds both tier-1 ≥ 0.703 AND tier-2 ≥ 0.627.**

### Eval-B coherence (tier-2)

All Option O configs: **1/4 coherent arcs** (matching Phase 2.1
`bfs wfusion τ=0.2 = 1/4`); `central β=0.25` regresses to 0/4. No
movement on the eval-B coherence target (which was 2/4 to pass).

### Ablation findings (interpretation)

- **Lateral inhibition is corpus-direction-dependent.** On tier-1
  it lifts mean F1 (β=0 → 0.536; β=0.15 → 0.682, +0.146). On
  tier-2 it slightly *hurts* (β=0 → 0.507; β=0.15 → 0.474, −0.033).
  This is the opposite of the SYNAPSE adversarial-robustness
  ablation (96.6 → 71.5 F1 when inhibition removed) — our tier-2
  failure modes apparently aren't of the adversarial-distractor
  shape that inhibition addresses, despite our prior diagnosis.
- **Higher decay (δ=0.7, retention 0.3) regresses sharply on
  tier-1** (0.682 → 0.467 at the same M, β). Activation needs to
  carry across hops on the small tier-1 graph; tier-2 is less
  sensitive to δ.
- **More propagation (T=3) ties or regresses vs T=2** on both
  tiers. The paper's T=3 default is over-propagation on our
  graph density.
- **β=0 isolation row drops below the best β>0 row on tier-1
  (-0.146)** — confirms the inhibition mechanism *does* work as
  designed. The negative aggregate result is not "inhibition is
  broken," it's "inhibition is the wrong primitive for the
  coherence ceiling we're hitting."

### Why the negative result

Two plausible mechanisms (untested):

1. **Spreading dilutes the seed.** Even with top-K filtering, the
   propagated set adds neighbors that have weaker per-probe cosine
   than the seed. On our compact graphs (tier-1 = 33 nodes,
   tier-2 = 236 nodes), the seed is already ≥ 50% of the
   reachable candidate space at `maxHops=2`, so propagation buys
   no new signal it just adds noise. Per the SYNAPSE paper, the
   mechanism was validated on LoCoMo (16k-token dialogues); our
   corpora are 1-2 orders of magnitude smaller.
2. **Tier-2 failure modes ≠ vocabulary-distractor.** The Phase
   2.4 diagnosis labelled `pw_pausanias_commands` on "generals" as
   a vocabulary-distractor failure. On re-inspection, this is more
   accurately a *retrieval-precision-vs-recall* tradeoff than a
   distractor — pausanias appears in the ideal set for several
   queries; the failure is over-broad inclusion under low-IDF
   tokens, which inhibition between near-cosine-equal anchors
   cannot fix.

### Status updates

- **Phase 2.10**: KILLED, ships as opt-in. No default change.
- **Phase 4 (4b activation-persistence)**: Subsumed-by-2.10 path
  is dead — Option O didn't validate, no activation profile to
  persist. Phase 4 reverts to the 4a edge-hotness branch as the
  only live cache option.
- **Phase 2.11 (MAGMA per-view routing)**: Promoted to NEXT. The
  remaining architectural hypothesis (merging three edge types
  into one adjacency discards routing signal) is now the primary
  research bet.
- **Open question for next session**: Is the LongMemEval retarget
  (Phase 7) more strategic to do first? At LongMemEval scale,
  Option O's "small graph dilution" argument might invert and the
  primitive could be worth re-running.

### Files touched

- `src/types.ts` — `AnchorScoring` + `"spreading-activation"`
  variant
- `src/retriever.ts` — new `composeAnchors` branch +
  `spreadingActivationRank` private method + `applyLateralInhibition`
  helper at file scope (~140 lines total)
- `tests/retriever.test.ts` — 8 new Phase 2.10 tests (all passing)
- `eval/sweep.ts`, `eval/iterative-sweep.ts` — 21 Phase 2.10 rows
- `notes/phase-2.10-reading.md` — SYNAPSE reading note

## Phase 4a — Edge-hotness soft-penalty gate on Dijkstra (2026-04-17)

Motivation from `path_memory_phase29` + `PLAN-post-2.8.md` §
"Phase 4 redesign": Phase 2.9 measured 7.72× mean edge concentration on
repeat-user traces; Option O's activation-persistence substrate was
killed, leaving 4a (hot-edge cache) as the only live Phase-4 shape. 4a
shipped as a **pre-experiment** (disabled-by-default) to confirm the
hot-edge prune hypothesis empirically and to produce a latency baseline.
Plan file: `~/.claude/plans/jaunty-sauteeing-goose.md`.

Design choices fixed up-front with the user:
- **Soft penalty** over hard prune (reversible via penalty=1.0; matches
  the roadmap's "higher threshold" phrasing).
- **Rolling in-session** hot set built from `accessStatsSnapshot()` once
  per `retrieve()` call — shared across every anchor's Dijkstra.

### Result: KILL — ship disabled-only, Phase-4 slot stays open

**Eval-A (no regression, gate is a no-op on scatter queries):**

| Tier | Phase-2.8 baseline | 4a hotK ∈ {50,100,200} × penalty ∈ {1.5, 2.0} |
|---|---|---|
| Tier-1 (12 queries) | 0.703 / 5 wins | 0.703 / 5 wins — all 6 rows exact baseline |
| Tier-2 (19 queries) | 0.627 / 4W 2L | 0.627 / 4W 2L — all 6 rows exact baseline |

**Eval-B tier-2 iterative (no coherence change):** all 6 rows
narrowed=4/4, coherent=1/4 (Phase-2.8 baseline).

**Eval-C (the actual test): refutation.** On all 8 repeat-user traces
under `hotK=100`:

| Variant | mean edgeRatio | mean coverage@5 | mean retrieveMs per trace | Δ latency vs baseline | Δ coverage vs baseline |
|---|---|---|---|---|---|
| baseline (2.8 default) | 7.72 | 0.643 | 326.1 | — | — |
| 4a hotK=100 penalty=1.5 | 8.44 | 0.643 | 440.7 | **+114.6ms (+35%)** | +0.000 |
| 4a hotK=100 penalty=2.0 | 8.65 | 0.643 | 445.3 | **+119.2ms (+37%)** | +0.000 |

Latency regressed on **8/8 traces**; coverage moved on 0/8.

### Interpretation

Soft-penalty re-weights cold edges — it does not prune them. Dijkstra
must still expand cold-edge states to prove they are sub-optimal, and
the re-weighted frontier takes *more* pops to converge (edgeBumps grow
≈5-10% under the gate). Phase 2.9's edge concentration signal does
actually get *amplified* (edgeRatio 7.72 → 8.44-8.65) — the hot set is
self-reinforcing under the gate — but the wrong metric was lifted: we
wanted latency to drop, not concentration to rise further.

Two directions remain open for future work; both are out of scope for
4a's pre-experiment charter:

1. **Hard prune** (skip cold edges entirely once the hot set is
   populated). Plausible latency win but accuracy risk on cold corpora —
   explicitly deferred per user choice at plan time.
2. **Pre-computed hot-edge subgraph index**, bypassing the generic
   `neighbors()` expansion for hot edges. Larger refactor; only worth
   revisiting if the Phase-4 slot needs a real owner after Phase 2.11.

### Decision

Per `PLAN-post-2.8.md` § "Pass / kill criteria":
- Eval-A hold: PASSED.
- Eval-C ≥ 15% latency win with no accuracy regression OR lift at
  latency parity: **FAILED** (latency regressed; coverage flat).

Kill triggered. Ships as-is (both config fields wired, disabled by
default). Phase-4 slot reverts to open per `PLAN-post-2.8.md`; Phase
2.11 (MAGMA per-view routing) is the next entry point for the primary
research path.

### Files touched

- `src/types.ts` — `hotEdgeTopK`, `hotEdgeColdPenalty` added to
  `RetrievalOptions` (disabled-by-default; both must be set for the
  gate to activate)
- `src/retriever.ts` — `buildHotEdgeSet` helper at file scope;
  hot-set construction at the top of `retrieve()`; `shortestCostPaths`
  signature + cold-edge cost gate at the edge-cost block
- `tests/retriever.test.ts` — 5 new Phase-4a tests (gate inert under
  accessTracking=off / BFS / penalty=1.0; empty-hot-set no-op; rolling
  populates across queries)
- `eval/sweep.ts`, `eval/iterative-sweep.ts` — 6 Phase-4a rows each
- `eval/eval-c-access.ts` — extended with `VARIANTS` (baseline vs 4a);
  per-trace wall-clock latency via `performance.now()`; `coverage@5`
  using `expectedClaimsAfterThisTurn` from the repeat-user traces

## Phase 2.13 — Encoder upgrade round 2 (BGE-base / BGE-large) (2026-04-17)

### Motivation

Strategic-review #1 said `all-MiniLM-L6-v2` was the weakest link; Phase 2.7
ran the first rung (MiniLM → BGE-small). That delivered a narrowing win
(2/4 → 4/4 on tier-2 eval-B) but left coherence flat at 1/4. Phase 2.6/2.8
diagnosed the residual ceiling as *within-cluster embedding granularity*
— an embedding-layer limit no anchor-scoring primitive can fix. Phase 2.13
takes the next rung within the same family: BGE-base (768d) and BGE-large
(1024d) against BGE-small (384d) as control.

Phase 7 (LongMemEval) and everything LLM-adjacent are currently parked;
this is the only remaining non-LLM path with a pre-diagnosed target.

### Swap

`download-model.ts` gains `bge-base` and `bge-large` entries (both
BAAI/bge-*-en-v1.5, CLS-pooled, same WordPiece family as BGE-small).
`experiments/path-memory-smoketest/src/embedder.ts` is parameterized on
`ENCODER=bge-small|bge-base|bge-large` with bge-base as the new default.
Test and sweep harnesses read the same env var.

### Results (tier-2, narrow Phase-2.13 matrix via `CONFIG_SET=phase213`)

**Eval-A (`ENCODER=<…> TIER=tier2 CONFIG_SET=phase213 bun run eval/sweep.ts`):**

| Config | bge-small | bge-base | bge-large |
|---|---|---|---|
| bfs (default) | 0.561 | 0.581 | **0.722** |
| dijkstra tmp=0.5 | **0.627** | **0.649** | 0.573 |
| A3 bfs wfusion τ=0.2 | 0.561 | 0.581 | **0.722** |
| A3 dijkstra tmp=0.5 wfusion τ=0.2 | **0.627** | **0.649** | 0.573 |
| J bfs min-gate τ=0.1 | **0.627** | 0.643 | 0.587 |
| J bfs min-gate τ=0.2 | **0.627** | 0.643 | 0.587 |

**Eval-B (`… bun run eval/iterative-sweep.ts`):**

| Config | bge-small | bge-base | bge-large |
|---|---|---|---|
| bfs wfusion τ=0.2 (no decay) | 4/4 narrow · 1/4 coherent | 4/4 · 1/4 | 4/4 · 0/4 |
| bfs wfusion τ=0.2 + decay=0.3 | 4/4 · 0/4 | 4/4 · **2/4** | 4/4 · **2/4** |
| J min-gate τ=0.1 + decay=0.3 | 4/4 · 0/4 | 4/4 · 0/4 | 4/4 · 0/4 |
| J min-gate τ=0.2 + decay=0.3 | 4/4 · 0/4 | 4/4 · 0/4 | 4/4 · 0/4 |

### Outcome tag: **A — coherence ceiling lifts, migrate default**

Both bge-base and bge-large hit the Phase-2.10 pass criterion
(coherence ≥ 2/4 on tier-2 eval-B) that no prior anchor-scoring primitive
ever reached. Eval-A either holds (bge-base +0.022) or jumps sharply
(bge-large +0.095 on BFS). The eval-B ceiling Phase 2.6/2.8 attributed
to embedding-layer granularity *was* real — and dim-scaling within the
BGE family fixes it.

### Side-findings

1. **Phase 2.8's "sessionDecay off by default" is encoder-stale.** Under
   bge-small, `decay=0.3` hurt coherence; under bge-base/large it's
   *load-bearing* for the 2/4 lift (coherence is 0–1/4 without it). Phase
   2.1's original "decay lifts coherence" claim (MiniLM era) re-emerges
   at bigger encoders; it was masked by BGE-small's sweet-spot alignment
   with no-decay.

2. **BGE-large flips the traversal default.** On bge-large, BFS wins
   eval-A (0.722) and Dijkstra regresses (0.573). Under bge-base the
   Phase-2.8 default (Dijkstra + wfusion) still wins (0.649). This is
   a structural encoder-geometry shift, not noise — 3 of 6 tested rows
   show it consistently.

3. **J min-gate is encoder-tuned to bge-small.** It tied for the tier-2
   eval-A top at bge-small (0.627) and now regresses on both base/large.
   Moves into the prune list alongside L, M α≥0.5, A1, H.

### Migration

**New default: `bge-base` (768d).** Reasons:
- Gives the coherence lift 1/4 → 2/4 and the cleaner eval-A lift
  (+0.022 on the Phase-2.8 default row — no traversal retune needed).
- bge-large's extra +0.072 eval-A comes entirely from a BFS-flip that
  *also* requires re-tuning the anchor-scoring primitive set.
- Cost: ~3× bge-small per-embedding latency (vs ~5× for bge-large) and
  436 MB on disk (vs 1.3 GB).
- bge-large is available as an opt-in (`ENCODER=bge-large`) and
  deserves its own phase to re-establish the traversal/anchor defaults
  — logged for a future Phase 2.14 if scale results demand it.

`experiments/path-memory-smoketest/src/embedder.ts` default → `bge-base`.
Library default (`src/adapters/onnx-embedding.ts`) stays MiniLM for
downstream-consumer back-compat — library consumers pass their own
`modelDir`.

### Implications for next session

- **Coherence ceiling is no longer the primary bottleneck** on tier-2
  eval-B. Moving from 2/4 to 3/4 is the publishable step; the remaining
  2 failing arcs should be inspected claim-by-claim (which probes miss
  under bge-base?) to see whether the gap is still embedding-layer or
  has shifted to something else.
- **Re-tag Phase-2.8 pruned-primitive list.** Session decay is back in
  the on-by-default position under bge-base. J min-gate moves to the
  prune list. Option M wasn't tested here (pruned per plan) but the
  across-encoder tuning instability argues against re-introducing it
  without a fresh encoder-specific sweep.
- **BGE-large's BFS-flip is a standing question.** A separate
  bge-large retuning pass could plausibly push eval-A above 0.722 by
  finding BFS-friendly anchor primitives — decoupled from the coherence
  question which is now resolved.

### Files touched

- `src/bin/download-model.ts` — `bge-base`, `bge-large` entries added
  to the `MODELS` registry; help text updated.
- `experiments/path-memory-smoketest/src/embedder.ts` — `ENCODER` env
  var (default `bge-base`); per-encoder cache; exported `resolveEncoder`
  + `ENCODER_DIMS`.
- `experiments/path-memory-smoketest/tests/embedder.test.ts` — reads
  encoder from the same source as the adapter; dimension assertion is
  parameterized.
- `experiments/path-memory-smoketest/tests/eval-iterative-tier2.test.ts`
  — updated the Phase-2.1/2.7/2.13 encoder-history comment. No
  assertion changes (narrowing floor still held).
- `experiments/path-memory-smoketest/eval/sweep.ts`,
  `experiments/path-memory-smoketest/eval/iterative-sweep.ts` —
  `CONFIG_SET=phase213` filter that restricts the sweep matrix to the
  narrow Phase-2.13 subset (BGE-era non-pruned rows only).

## Phase 2.14 — Anchor-primitive retune under bge-base (2026-04-17)

Phase 2.13 left three open questions. We picked the top one: "can bge-base
lift coherence from 2/4 → 3/4 by re-tuning anchor primitives against its
geometry?" The answer is **yes, via `sessionDecayTau` alone** — the Phase 2.13
choice of `decay=0.3` sits on the edge of a narrow sweet-spot, not its
interior.

### Stage 0 — per-arc diagnostic

Before sweeping, `eval/iterative-sweep.ts:runConfig` now records per-arc
narrow/coherent/coverage (gated behind `PER_ARC=1`). Under the Phase-2.13
best (`bfs wfusion τ=0.2 + decay=0.3`), the 2-of-4 coherence breakdown is:

- ✅ `philosophers to Alexander arc`   cov=1.00
- ❌ `Athens at war arc`               cov=0.33
- ✅ `Academy arc (asOf 360 BCE)`      cov=0.67
- ❌ `Alexander succession arc`        cov=0.33

Both failures sit at 0.33 — the retriever is one-correct-claim-short of the
0.5 pass threshold on each. Not a structural wall.

### Stage 1 — 1D sweeps on currently-live knobs

Narrow matrix under `CONFIG_SET=phase214` (10 rows, ~6 min on bge-base):
control + `sessionDecayTau ∈ {0.1, 0.2, 0.4, 0.5}` + `weightedFusionTau ∈ {0.1, 0.15, 0.3}` + `anchorTopK ∈ {3, 7}`.

| Row                                        | Coherence | Per-arc |
|--------------------------------------------|-----------|---------|
| control `decay=0.3` (Phase 2.13)           | **2/4**   | Ph✅ Ath❌ Ac✅ AxS❌ |
| **`decay=0.1`**                            | **3/4**   | Ph✅ **Ath✅** Ac✅ AxS❌ |
| **`decay=0.2`**                            | **3/4**   | Ph✅ **Ath✅** Ac✅ AxS❌ |
| `decay=0.4`                                | 1/4       | Ph❌ Ath❌ Ac✅ AxS❌ |
| `decay=0.5`                                | 1/4       | Ph❌ Ath❌ Ac✅ AxS❌ |
| `wfusion τ ∈ {0.1, 0.15, 0.3}`             | 2/4 (flat)| unchanged |
| `anchorTopK=3`                             | 2/4       | unchanged (but arcs shift) |
| `anchorTopK=7`                             | 0/4       | all regress |

Key observations:
- Decay curve is **non-monotonic** under bge-base: 0.1/0.2 lift, 0.3 is
  a 2/4 plateau, ≥0.4 collapses coherence back toward 0.
- Both winners flip the **same** failing arc (Athens at war, 0.33 → 0.67);
  they do not cycle arcs, so the 3/4 is real, not a reshuffle.
- Alexander-succession stays at 0.33 on every row tested — it is the new
  eval-B ceiling and a candidate for question-3 claim-level inspection.
- `weightedFusionTau` and `anchorTopK` are both flat or regressive under
  bge-base — the signal is concentrated in `sessionDecayTau`.

### Stage 2/3 skipped

Stage-1 already produced a clean 3/4 winner with an arc flip and no
cycling. Stage 2 (re-test Options H / A1 under bge-base) and Stage 3
(combination runs) were unnecessary.

### Outcome: A' — new default `sessionDecayTau=0.2`

- 3/4 coherence reached on tier-2 eval-B without eval-A regression
  (eval-A `CONFIG_SET=phase214` shows decay=0.1/0.2 match the
  wfusion-τ=0.2 baseline at mean-F1 0.581 — confirmed inert on
  single-turn queries).
- The failing arc flip (Athens at war, 0.33 → 0.67) is a real gain, not
  a metric reshuffle.
- New recommended session knob under bge-base: **`sessionDecayTau: 0.2`**
  (was 0.3 under Phase 2.13). The prior Phase-2.8 "decay off" default
  was MiniLM/BGE-small-era; Phase 2.13 re-enabled at 0.3; Phase 2.14
  narrows to 0.2.
- 0.1 is equally good on tier-2 eval-B; 0.2 chosen as the more
  conservative move (smaller delta from the prior 0.3 default, in
  the interior of the {0.1, 0.2} pass band, and symmetric with the
  failure wall at 0.4).

### Updated prune list (post Phase 2.14)

No changes vs Phase 2.13 — `weightedFusionTau` and `anchorTopK` variations
all fell flat under bge-base but don't cross the "harmful" line for the
default (0.2 stays as wfusion τ).

### Next session — three open questions

1. **Lift 3/4 → 4/4 (Alexander-succession arc).** This arc stayed at
   0.33 on every Stage-1 row and every `decay ∈ [0, 0.5]` value tested.
   Needs *either* a different anchor-scoring family (H / A1 under
   bge-base), *or* claim-level inspection to see what the arc's expected
   claims look like under bge-base's embedding geometry (likely a
   Diadochi-era cluster problem: probes fan into ambiguous succession
   claims).
2. Phase 2.13 question 3 reheated: for the Alexander-succession arc
   specifically, *which* of the 3 expected claims is the retriever
   missing on the final turn? If it's a single consistent claim across
   runs, that claim's embedding may need re-inspection. Implementation:
   extend runArcs `PER_ARC=1` logging to also dump the missing
   `expectedClaims` for the final turn.
3. Phase 2.13 question 2 (bge-large BFS-flip retune) still parked.

### Files touched

- `experiments/path-memory-smoketest/eval/iterative-sweep.ts` — per-arc
  breakdown under `PER_ARC=1`; Phase-2.14 config block (decay / wfusion
  τ / anchorTopK rows); `CONFIG_SET=phase214` filter.
- `experiments/path-memory-smoketest/eval/sweep.ts` — winner rows
  (`decay ∈ {0.1, 0.2}`) + `CONFIG_SET=phase214` filter for regression
  check.
- `experiments/path-memory-smoketest/tests/eval-iterative-tier2.test.ts`
  — decay default `0.3 → 0.2`; comment block updated with Phase-2.14
  history. Assertion unchanged (narrowing floor only).
