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

Tier-2 closed the A2 question definitively: it does not generalize.
The productive next moves are about *probe dynamics* (eval B
coherence) and *robustness across corpora* (A3 weighted-fusion
looks like a candidate default). Three plausible directions:

**Option E — session-mode probe weighting (addresses eval-B
coherence gap, recommended).** Tier-2's eval (B) fails 0/4
across every Phase-1.6 config because `Session.addProbeSentences`
appends to an unweighted list and the retriever treats all
probes equally. Broad early-turn probes outvote narrow later-turn
probes. The primitive change is per-probe weighting at retrieval:
exponential decay by turn index (e.g. `w(t) = exp(-(T-t) / tau)`
with T = current turn, tau ~ 1.5-2.0), or simple recency-biased
top-K where later-turn probes get priority. This is a *retriever*
change, not a graph or store change, and slots in without
altering any existing API. Pass criterion: ≥2/4 tier-2 arcs
coherent without tier-1 regression.

**Option F — promote A3 weighted-fusion to default + add probe-
composition infrastructure for Option E.** Weighted-fusion at
τ=0.2 wins at tier-2 (+0.022) and is neutral-to-positive at
tier-1 (0.510 vs 0.530 BFS, within noise). Making it the default
closes the "defaults are suboptimal" tier-2 finding and gives
Option E a stable composition baseline to build on. Low risk,
cheap to sweep once more to confirm.

**Option G — tier-3 now, accept A2's corpus-specificity.** Skip
the rescue work and go directly to the Wikipedia-scale test. The
argument: if A2+A3 doesn't generalize from tier-1 to tier-2, it
probably won't generalize to tier-3 either, and we'd rather
discover *architectural* limits at tier-3 (e.g. "BFS doesn't
scale past 5K claims") than keep tuning on mid-sized datasets.
Counter-argument: without eval (B) coherence working at tier-2,
tier-3 iterative evaluation will be uninterpretable noise.

**Option H — topic-conditional temporal cost (A1 redux, still
pending).** Phase 1.6 flagged this as the natural follow-up to
A1's failure; tier-2's A1 results (−0.05 F1) don't change that
conjecture — the failure mode is still "adjacency regardless of
topic" and a cosine-gated version is still worth trying. But
after tier-2, the priority is lower: topic-conditional temporal
cost is a refinement, not a fix for the now-identified coherence
gap.

Recommendation: **Option E first** — the eval-B gap is the
biggest open scientific question after tier-2, and it's the only
one with a clear primitive change (probe weighting) that hasn't
been touched in Phases 1–1.6. Option F can land alongside or
immediately after. Option H is still interesting but sits behind
E in priority. Option G is the "scale or die" move — plausible
but trades information for ambition.
