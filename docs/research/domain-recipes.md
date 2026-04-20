# Per-Domain Recipes

Three proposed stacks drawing on `atlas.md` and `combinations.md`. No benchmark numbers here; those come from the plan that follows this research.

Every recipe names a non-AI backbone, at most 2 local-LLM insertion points, a ceiling statement, explicit mapping to prior work, and open questions.

---

## Chat domain

### Domain sketch

Conversational and user-related memory. The store holds utterances, model replies, and facts derived from them. Typical queries are follow-ups ("what did I say about X yesterday?"), long-horizon preference recall ("what's my usual seat on flights?"), and temporal retrievals ("where did I work in 2023?"). A miss in product terms is the assistant either missing context the user just supplied ("you already know this!") or confidently using a superseded fact ("I thought I told you I left that job").

### Non-AI backbone

- **Encoder:** BGE-base (per phase 2.13 promotion — BGE-large did not justify its cost in phase 2.15).
- **Retriever:** path-memory graph traversal with Dijkstra at `tmp=0.5` and weighted-fusion `τ=0.2` (phase 2.8 defaults, kept under BGE-base).
- **Temporal primitive:** exponential session decay at `sessionDecayTau=0.2` (phase 2.14) combined with event-valid-interval gating at query time (commits cbf9ea7, 9274ac3).
- **Paraphrase baseline:** synonym edges between near-duplicate entity surface forms + topic-linking plugin (commits e2b816a, 106b0a3).
- **Selection:** MMR budget-filling at the top-k selection step (commit 77e6484) so follow-ups do not get crowded out by near-duplicate top hits.

This backbone covers: paraphrase (via synonym edges + topic-linking), temporal (via valid-time gating + session decay), context (via path-memory graph traversal), aggregation-at-selection (via MMR).

### Known ceiling

Two miss-modes the backbone cannot kill:

1. **Granularity and decomposition at ingest** — a raw turn is stored as one unit, so a turn with three claims is embedded as an average of three signals. Phase 2.15 documents this as "encoder-granularity-bound." No tuning of the encoder closes this; it requires splitting the unit of memory.
2. **Compositional queries requiring atomic-level joins** — "what did Alice and I agree on last week and is it still current?" needs atom-level retrieval with per-atom validity. The whole-turn unit loses this.

### Where the local LLM earns its tokens

**Insertion 1: atomic-fact extraction at ingest**

- **What it does:** Rewrites each incoming turn into a list of standalone claims in subject-predicate-object form, each with a `validFrom` timestamp extracted from the turn.
- **Why no algorithm replaces it:** Distinguishing a standalone claim from conversational filler requires semantic judgment no rule-based extractor delivers reliably at chat-text messiness.
- **Token cost:** ~1 local-LLM call per ingested turn. Turns average ~50 tokens in; output is usually <200 tokens out. Similarity batching at the inbox stage groups related pending turns so a single call can process several turns.
- **Plausible recall delta:** unlocks the granularity + decomposition miss-modes the backbone cannot touch. This is the single largest expected gain.

**Insertion 2: contradiction-based supersession routed by valid-time**

- **What it does:** At consolidation, identify claims about the same subject that cannot both be true, and close the loser's valid-time interval at the winner's `validFrom` (not at ingest-order).
- **Why no algorithm replaces it:** Identifying "A contradicts B about the same subject" is a world-knowledge problem. Embedding similarity gets close but confuses "same subject, compatible claims" with "same subject, incompatible claims."
- **Token cost:** 1 local-LLM call per conflict group, amortized via similarity batching (§B similarity_batching). Most ingested facts do not trigger a conflict call.
- **Plausible recall delta:** eliminates stale-fact pollution end-to-end and fixes the "newer-in-log wins over newer-in-world" bug that a plain `invalidAt`-on-consolidation policy has.

No third insertion point — query-side rewriting and listwise LLM rerank fail the "cheaper in total tokens than recall bought" test for Chat workloads.

### Relation to what's already in the repo

- **Extends:** inbox redesign (commits 4c255fc user, 115c5bd code-repo — atomic fact decomposition already exists for those domains, not yet for chat) and the Chat temporal-validity spec (`docs/superpowers/specs/2026-04-12-chat-temporal-validity-and-semantic-dedup.md`, commits cbf9ea7, 9a6350a, d600b32, 9274ac3, a6f789f, 9d9c6ce).
- **Defaults that change:** Chat ingest goes from whole-turn storage to atomic-fact storage. Consolidation routing moves from `invalidAt`-on-ingest-order to supersession-by-`validFrom`. Phase 2.14 `sessionDecayTau=0.2` default is preserved.
- **What dies:** whole-turn embedding as the primary retrieval unit. Turn remains as a pointer from each atom (context-preserving decomposition, §1).
- **What the recipe inherits:** phase 2.9's repeat-user edge-concentration observation (8/8 PASS) — atoms on the graph side benefit from the same concentration. Phase 2.13 encoder choice. Phase 2.14 decay τ.

### Open questions

1. Does routing supersession by `validFrom` rather than ingest order flip the Alexander-succession arc that phase 2.14 Stage 2 diagnosed as encoder-granularity-bound? The granularity fix from atomic extraction is the independent variable.
2. Does atomic-fact extraction at ingest cost more in total tokens than the multi-hop retrieval + follow-up generation it replaces at query time? The "LLM only when it pays for itself" rule demands measurement.
3. What similarity-batch size minimizes total local-LLM spend across a typical Chat day? Underbatching wastes overhead, overbatching causes cross-contamination between unrelated conflict groups.

---

## KB domain

### Domain sketch

Structured data with schema-bearing records. Typical queries are compositional ("which KBs have feature X and also do Y?"), schema-specific ("what is the `auth_method` field of record R?"), and granularity-sensitive (right answer is a sub-record, not the parent). A miss in product terms is a query returning the parent record when the sub-record is what the user needs, or returning adjacent records because the schema relation was not matched.

### Non-AI backbone

- **Encoder:** BGE-base (phase 2.13).
- **Retrievers (run in parallel):** dense vector via BGE-base; lexical via keyword CONTAINS search (commit 14aa61f replacing BM25 supplemental); graph traversal via path-memory (phase 2.8 defaults). This is a three-retriever pool, which is what phase 7.6 candidates implicitly recommended for precision tuning.
- **Fusion:** Reciprocal-rank fusion across the three retrievers (phase 2.16's opt-in RRF promoted to default, with cross-family RRF extended beyond same-family encoders — the open Stage B/C/D slot phase 2.16 flagged).
- **Selection:** MMR budget-filling at top-k (commit 77e6484) to preserve evidence diversity for compositional queries.
- **Paraphrase baseline:** synonym edges + topic-linking + topic-based score boosting (commit 776e1af).
- **Precision knobs:** tightened `resultTopN` and `anchorTopK` (phase 7.6 candidate — cascade pool-size tuning under a different name).

This backbone covers: paraphrase, lexical, compositional (via graph + fusion), aggregation (via MMR), and schema at a coarse level (via topic-linking).

### Known ceiling

Two miss-modes the backbone cannot kill:

1. **Schema-level relations** — "which records have `auth_method=oauth2` AND also satisfy constraint Y?" requires the fields to be extractable and typed, not just embedded. Topic-linking is too coarse; it gets "authy stuff" but not "oauth2 specifically."
2. **Granularity traps** — a query that should return a sub-record often returns the parent because the parent's embedding is the average of all sub-records, which is close enough to every sub-query to always rank.

### Where the local LLM earns its tokens

**Insertion 1: atomic-fact decomposition with parent-link at ingest**

- **What it does:** On record ingest, extract atomic facts keeping a pointer to the parent record (the A+B+C fix from `kb_decomposition_next_steps`). Each atom gets its own embedding and its own retrieval probability, but the parent can still be reconstructed.
- **Why no algorithm replaces it:** Identifying the "unit of claim" inside a structured record requires understanding the record's content, not just its schema. Rule-based splitting produces too many useless atoms.
- **Token cost:** 1 local-LLM call per ingested record, batched across records in the same ingest burst.
- **Plausible recall delta:** directly kills the granularity-trap miss-mode.

**Insertion 2: schema-guided claim canonicalization at ingest (SPIRES/KGGen variant)**

- **What it does:** For each atomic claim, coerce it into a typed form against the domain schema (field name, value, value type). Stored alongside the embedding as structured metadata, filterable at query time without LLM.
- **Why no algorithm replaces it:** Aligning a natural-language claim to a schema field requires the LLM. Once aligned, the filter is cheap and deterministic.
- **Token cost:** 1 local-LLM call per atomic claim (piggybacked on Insertion 1 — same call emits both the split and the schema alignment).
- **Plausible recall delta:** kills the schema miss-mode and enables precise structural queries ("auth_method=oauth2") that embedding retrieval cannot match reliably.

Both insertions fit in ONE local-LLM call per record. The budget is "1 local-LLM call per ingest, 0 per query" — which matches the Chat/KB ingest-heavy tilt from the brainstorming conversation.

### Relation to what's already in the repo

- **Extends:** commit 3309841 (KB temporal validity + atomic decomposition groundwork); `kb_decomposition_next_steps.md`.
- **Supersedes:** removed outer-query intent-gate (commit 106b0a3). Per §3 Sub-question fanout's prior-art note, the refutation is at outer-query granularity — the recipe moves any intent signal to the atom/sub-query level.
- **Parks (still available behind toggles):** wired embedding rerank (91874db), LLM rerank (607d943, currently parked via `feedback_exhaust_non_llm_first`). Cross-encoder rerank is the next candidate if this recipe's non-AI backbone doesn't close phase 7.6's precision diagnosis.
- **Defaults that change:** KB ingest does atomic decomposition + schema coercion in one call. RRF fusion across three retrievers becomes default (phase 2.16 promoted from opt-in). `resultTopN`/`anchorTopK` are tightened per phase 7.6 candidate analysis.
- **What dies:** reliance on outer-query intent classification as a front-gate.

### Open questions

1. Does schema-aware claim typing at ingest pay back its token cost in reduced query-side compute? If most queries still need a cross-encoder rerank, the ingest investment was wasted.
2. Is cross-retriever (BM25 + dense + graph) RRF enough to fix phase 7.6's precision diagnosis, or does it need a cross-encoder mid-stage?
3. Does the atomic + parent-link decomposition introduce retrieval duplicates (parent records and their atoms both ranking high for the same query)? If yes, MMR may handle it; if not, explicit parent-atom dedup is needed.

---

## Silentium domain

### Domain sketch

Long historical data used to inform predictions. The store is large, sparse-over-subjects, heavy on sequential events. Typical queries are analogy-driven ("this situation rhymes with what past cases?"), compositional-temporal ("what sequence of events preceded outcome X?"), and sparse-precedent ("only 1–2 historical cases match; find them in the noise"). A miss in product terms is the prediction lacking the one precedent that would have shifted it.

This domain is category B per the brainstorming conversation: ingestion is dumb (chunks + embeddings), query is heavy. The LOCOMO/MSC baselines from phase 7.5 are the external scoreboard.

### Non-AI backbone

- **Encoder:** BGE-base (phase 2.13).
- **Retriever:** path-memory graph traversal (phase 2.8 defaults), extended with **time-aligned subgraph restriction** (family 5 entry) — edges carry timestamps/intervals, traversal restricts to the time window the query implies. The `event_time` index (commit 8d587ac) + `validFrom`/`invalidAt` (cbf9ea7) are the substrate; the time-alignment step is the open atom.
- **Density primitive:** Personalized PageRank over the time-aligned subgraph (family 2). This replaces the refuted SYNAPSE tier-inhibition (phase 2.10) with the non-inhibited cousin — the refutation was specific to tier-inhibition + small-graph dilution, which PPR avoids.
- **Selection:** MMR at top-k for diversity across precedents.
- **Paraphrase baseline:** synonym edges + topic-linking.

This backbone covers: temporal (via time-aligned subgraph + bi-temporal edges), compositional (via PPR), paraphrase (via synonyms), scale (via topic-linking prune).

### Known ceiling

Two miss-modes the backbone cannot kill:

1. **Analogy misses** — a query that rhymes with a past situation but shares no surface features (no overlapping entities, no keyword matches). Graph walks from empty seeds produce nothing; embedding similarity is too weak across different entity sets.
2. **False-friend context misses** — PPR seeds hallucinate when a query entity happens to also appear in a thematically-unrelated cluster. One bad seed poisons the walk.

### Where the local LLM earns its tokens

**Insertion 1: query decomposition with step-back + sub-question fanout**

- **What it does:** Two local-LLM calls at query time: (a) step-back to generate an abstract version of the query ("what kind of situation is this?"); (b) sub-question fanout to break the query into atomic retrievals. Both rewrites retrieve in parallel and merge via RRF (compound 5 in `combinations.md`).
- **Why no algorithm replaces it:** Analogy misses require semantic abstraction that embeddings alone cannot perform — the whole miss-mode is that surface features disagree, so any embedding-only method is stuck by construction.
- **Token cost:** ~2 local-LLM calls per query (one per rewrite). If query volume is low and the domain is query-heavy by design (category B), this is the budget the user explicitly allocated.
- **Plausible recall delta:** kills analogy misses (via step-back) + compositional misses (via fanout), which are Silentium's two dominant failure modes per the domain sketch.

**Insertion 2: recognition-memory triple filter after retrieval**

- **What it does:** Before the final PPR walk, take the top-N retrieved seed triples and run one local-LLM call asking "which of these actually match the query intent?" Drop the rejected seeds.
- **Why no algorithm replaces it:** This is the "system 2" check that catches false-friend embeddings — lexical near-matches that are semantic far-matches. Cross-encoders can do this for passages, but for triples the LLM is cheaper and more accurate.
- **Token cost:** 1 small local-LLM call per query (input is <50 triples × ~20 tokens = 1K in, <100 tokens out).
- **Plausible recall delta:** kills false-friend context misses, which PPR alone cannot catch — this is exactly what HippoRAG 2 introduced the mechanism for.

Total local-LLM budget: 3 calls per query, all small. If the user wants to cap at 2, drop the triple filter first — the query rewrites address the dominant failure modes and the triple filter is precision-over-recall at the margin.

### Relation to what's already in the repo

- **Extends:** phase 7.5 LOCOMO/MSC baselines (12.6% contain / 32.1% evidR; 33.2% persona recall) — this recipe targets the precision gap phase 7.6 candidates diagnosed (evidR >> contain means candidates are retrieved but wrong ones rank at top).
- **Replaces:** SYNAPSE tier-inhibition (phase 2.10, refuted) with Personalized PageRank. The refutation is honored — we do not re-ship the refuted variant.
- **Supersedes / shelves:** MAGMA per-view router (phase 2.11, deferred). PlanRAG-style sub-question leaves (Insertion 1 above) are the revised-granularity variant of MAGMA's whole-query-view routing.
- **Defaults that change:** query-time graph walks become time-aligned by default when the query carries or implies a time scope. PPR replaces the default Dijkstra walk for queries classified as "density" rather than "path-shape" (a sub-question-level classification, not an outer-query one — avoids the kb intent-gate refutation).
- **Inherits:** phase 2.9's edge-hotness observation (repeat-user arcs concentrate 7.72×) but does not use it as a soft-gate (phase 4a refuted that).

### Open questions

1. Does time-aligned subgraph traversal close the analogy gap when the query time-scope is implicit (the user says "situations like this" without naming a window)? If the time-scope inference requires an LLM call, Insertion 1 grows to 3 calls.
2. Can the recognition-memory triple filter (Insertion 2) replace the parked listwise LLM rerank (commit 607d943) at lower total token cost? If yes, this recipe also unblocks the "exhaust non-LLM first" parked work.
3. Is step-back's rewriting ceiling limited by the size/quality of the local model chosen? If small-local-model abstractions are too shallow for long-historical analogy, the insertion point is under-budgeted and needs a larger-local-model fallback.

---

## Recipes at a glance

| Aspect | Chat | KB | Silentium |
|---|---|---|---|
| Tilt | ingest-heavy | ingest-heavy | query-heavy |
| Backbone encoder | BGE-base | BGE-base | BGE-base |
| Backbone retriever | path-memory graph + session decay | RRF across {BM25, dense, graph} | path-memory graph + time-aligned subgraph + PPR |
| Local-LLM insertion 1 | atomic-fact extraction (ingest) | atomic-fact + schema coercion (ingest, 1 call) | step-back + fanout query rewrites (query) |
| Local-LLM insertion 2 | supersession by valid-time (ingest) | (covered by Insertion 1) | recognition-memory triple filter (query) |
| Biggest ceiling | none after insertions; residual: cross-session analogy | cross-encoder may still be needed if precision gap persists | analogy ceiling if step-back is local-model-limited |
| Closest live prior-art | temporal-validity spec 2026-04-12 + inbox redesign | phase 7.6 candidates + commit 3309841 | phase 7.5 LOCOMO/MSC + phase 2.10 SYNAPSE refutation |

---

## Research status

All success criteria from `docs/superpowers/specs/2026-04-20-memory-research-atlas-design.md` §Success criteria are met:

- Atlas coverage: 32 full entries + 10 survey stubs across 7 family sections.
- Miss-mode coverage: all 12 miss-modes have ≥3 entries (see atlas appendix).
- Combinations viability: 7 compounds, 4 nullifications, 4 conflicts.
- Recipes actionability: each recipe has named backbone, ≤2 local-LLM insertions (KB squeezes both into 1 call), prior-art paragraph with concrete pointers, 3 open questions, ≥1 stated ceiling.
- Prior-art coverage: every atlas entry has an explicit Prior-art note.
- Honest ceilings: every recipe names at least one residual miss-mode.

The next step is a separate brainstorming + planning round that picks one recipe to prototype against a specific eval (LOCOMO, MSC, or internal tier-N). This document is input to that round, not a commitment to a winner.
