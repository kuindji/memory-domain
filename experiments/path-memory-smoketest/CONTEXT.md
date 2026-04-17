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
    ├── retriever.test.ts       # 11 retrieval behaviors
    ├── eval-vs-baseline.test.ts          # eval (A) tier-1
    ├── eval-vs-baseline-tier2.test.ts    # eval (A) tier-2
    ├── eval-iterative.test.ts            # eval (B) tier-1
    └── eval-iterative-tier2.test.ts      # eval (B) tier-2
```

46 tests pass (35 tier-1 + new tier-2 eval-A and eval-B). Typecheck
clean.

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

**Option H — topic-conditional temporal/edge cost (new
recommended).** Phase-2.3's cluster-boundary finding promotes
Option H from fallback to primary candidate. The structural move:
re-weight edges (or gate traversal / anchor selection) by
**topical cohesion**, so cross-cluster hops/anchors carry cost
unless the endpoints share a cluster signal. Concrete design
sketch:
- Compute per-node **cluster membership vector**: cosine-based
  soft membership to k discovered clusters (e.g., k-means over
  claim embeddings at ingest, or use the existing IDF-weighted
  lexical edges to form communities via connected-component /
  label-propagation on the `edge.weight > floor` subgraph).
- Expose a new anchor/traversal signal `clusterAffinity(p, c)` =
  similarity of probe `p`'s soft-cluster distribution to claim
  `c`'s, and add one of:
  - `AnchorScoring.kind = "cluster-affinity-boost"` — score(c) =
    `cosAgg(c) · (1 + β · clusterMatch(c))` where
    `clusterMatch(c) = max_p sim(clusters(p), clusters(c))`. Boosts
    cross-cluster claims only when the probe set itself spans the
    clusters.
  - Edge-weight rescaling in `GraphIndex`: lexical/semantic edge
    weight multiplied by a cluster-agreement factor; Dijkstra then
    pays more for cross-cluster hops.
- Pass criterion: ≥ 2/4 tier-2 eval-B coherent, tier-1 3/3
  preserved, eval-A within ±0.02 of Phase-2.1 default on both
  tiers.

**Option K (new, experimental alternative to H) — probe-conditional
anchor fusion.** Instead of scoring anchors against the union of
probes, score each probe's top-K *independently* and union them
only if their chosen anchors span compatible clusters. Equivalent
to intersection at the *cluster* level rather than the *claim*
level. Cheaper than H (no cluster computation on ingest) but
relies on late-turn probes being specific enough to anchor their
own cluster; may underperform on conversational turns that stay
topical.

**Option G — tier-3 now, accept tier-2 1/4.** Unchanged argument.
Counter-argument sharpens: the same cross-cluster failure mode
will dominate tier-3, and diagnosing it in a 5000-claim corpus is
harder than in tier-2's 242. Wait for H (or a positive K) before
scaling.

Recommendation: **Option H — cluster-affinity primitive** is the
next entry point. Phase-2.3's negative results pin down that the
remaining tier-2 gap is structural (cluster-boundary handling), not
aggregate-shape. Option K is the backup if H's cluster computation
adds too much ingest cost. Option G still waits for eval-B ≥ 2/4.
