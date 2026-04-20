# Combinations, Nullifications, and Conflicts

Analytical layer over `atlas.md`. No per-domain ranking here — those live in `domain-recipes.md`.

## Compounds worth trying

### 1. Atomic-fact extraction + Sub-question fanout

- **Atlas entries:** Atomic-fact extraction (family 1); Sub-question fanout (family 3).
- **Why it compounds:** Extraction kills aggregation and compositional misses on the write side (multi-fact turns become multi-atom); fanout kills them on the read side (multi-fact questions become multi-query). Each decomposition closes the same miss-mode from its own end of the pipeline — belt and braces for the hardest miss modes.
- **Token cost:** 1 small LLM per ingested turn + 1 LLM per query + N retrievals per fanned-out sub-question.
- **Best-fit domain:** Chat (ingest-heavy tilt); can be pulled into KB when compositional queries dominate.

### 2. HippoRAG 2 core: Entity-anchored retrieval + Personalized PageRank + Recognition-memory triple filter

- **Atlas entries:** Entity-anchored retrieval; Personalized PageRank; Recognition-memory triple filter (all family 2). Optionally layer Passage nodes.
- **Why it compounds:** Entity anchoring produces precise seeds (kills paraphrase, lexical); PPR expands from seeds along density without hard hop limits (kills compositional, sparse-precedent); the triple filter is the cheap LLM check that prevents one bad seed from poisoning the whole walk (kills context, false-friend lexical). Each step protects the next.
- **Token cost:** 1 LLM per query for entity extraction + 1 small LLM per query for triple filtering + zero for PPR walk itself.
- **Best-fit domain:** KB (structured graph-shaped corpus) and Silentium (long historical graph).

### 3. Cascade: RRF → Cross-encoder → MMR

- **Atlas entries:** Reciprocal-rank fusion; Cross-encoder pointwise rerank; MMR budget-filling (family 4 + family 7).
- **Why it compounds:** RRF at the base merges heterogeneous retrievers (BM25 + dense + graph) into a large pool cheaply; the cross-encoder re-scores the shortlist with query-candidate attention the first stages can't do; MMR then trades a little score for diversity so the returned set isn't near-duplicates. Each stage fixes a different failure: RRF fixes single-retriever blind spots, cross-encoder fixes lexical/paraphrase misses, MMR fixes aggregation from duplicate crowding.
- **Token cost:** ≈ 1-per-item at the middle stage only, on a pool of ~200. No listwise LLM stage — the "exhaust non-LLM first" rule is respected.
- **Best-fit domain:** KB — the domain where precision is the active failure mode (phase 7.6 candidates diagnosis).

### 4. Temporal-correctness stack: Atomic-fact extraction + Contradiction supersession + Bi-temporal edges + Event-valid-interval gating

- **Atlas entries:** all four (families 1 + 5).
- **Why it compounds:** Atomic extraction gives each fact its own lifecycle; supersession closes out facts that contradict new ones; bi-temporal edges store both "when we learned it" and "when it was true"; valid-interval gating at query time filters out expired facts. Together they eliminate stale-fact pollution end to end — no mechanism alone suffices (supersession without bi-temporal gets confused by late-arriving old truths; bi-temporal without supersession produces duplicate valid facts).
- **Token cost:** 1 small LLM per ingested turn (extraction) + 1 LLM per conflict group (supersession) + zero at query.
- **Best-fit domain:** Chat (already partially implemented via commits cbf9ea7, 9a6350a, 9d9c6ce, a6f789f, 9274ac3). The open slot is routing supersession by `validFrom` rather than ingest order.

### 5. Dual-view query expansion: Step-Back + HyDE via RRF

- **Atlas entries:** Step-Back (family 3); HyDE (family 6); Reciprocal-rank fusion (family 4).
- **Why it compounds:** Step-Back abstracts the query upward (matches principles); HyDE hallucinates a concrete answer (matches evidence). They retrieve from opposite directions. RRF merges the two rankings without having to compare their scores. Phase 2.16's same-family-RRF finding — that view fusion lifts eval-A but regresses coherence — is the control case; this stack swaps encoder-distinct views for semantically-distinct views, which is the orthogonal axis that phase 2.16 did not test.
- **Token cost:** 2 LLM calls per query (one for each rewrite).
- **Best-fit domain:** Silentium (analogy-heavy queries benefit most from abstraction) and KB (compound queries benefit from the concrete-answer framing).

### 6. Global-question GraphRAG stack: LLM-extracted graph + Community summaries + Map-reduce global query

- **Atlas entries:** all three (family 2).
- **Why it compounds:** The graph gives structured entities; Leiden clustering over the graph produces communities at multiple zoom levels; pre-generated community summaries let broad questions be answered from short summaries instead of the corpus. Map-reduce fans out across communities and merges partial answers. This is the only combination that cleanly answers "what are the main themes?" style questions, which top-k retrieval fundamentally cannot.
- **Token cost:** expensive at ingest (one LLM per community per level); 1 LLM per community hit at query + one reduce call.
- **Best-fit domain:** Silentium (long historical traces with broad analytical queries); less suitable for Chat or KB where top-k retrieval is the norm.

### 7. Cheap cross-domain lexical safety net: Synonym edges + Entity-anchored retrieval + Topic-linking

- **Atlas entries:** Synonym edges, Entity-anchored retrieval (family 2); Topic-linking (family 7).
- **Why it compounds:** All three are near-zero-cost lexical/paraphrase primitives. Synonym edges bridge entity surface forms; entity anchoring uses them for retrieval; topic-linking supplies a coarse cross-domain index. Stacked they form a paraphrase-resistant baseline that runs before any expensive rerank stage. The underlying principle: attack paraphrase/lexical with cheap structured primitives, reserve LLM budget for what only an LLM can do.
- **Token cost:** near zero (LLM at ingest for topic/entity extraction, already amortized via tiered topic-linking).
- **Best-fit domain:** all three. This is a baseline-layer candidate for the framework.

---

## Nullifications and redundancies

### N1. HyDE ≈ Query2Doc

- **Atlas entries:** HyDE (family 6); Query2Doc (family 6).
- **Why stacking buys nothing:** Both mechanisms generate a pseudo-answer document via LLM and use it to expand the query. Query2Doc concatenates the pseudo-doc to the original query before embedding; HyDE embeds the pseudo-doc and uses its embedding directly. The differences are cosmetic relative to the shared mechanism. Running both is double-billing for the same signal.
- **Policy:** Pick one. Choice depends on whether the downstream retriever handles concatenated queries well (Query2Doc) or prefers clean embeddings (HyDE).

### N2. Exponential decay + Ebbinghaus reinforcement without coordination

- **Atlas entries:** Exponential decay of access score; Ebbinghaus-style reinforcement on re-access (family 5).
- **Why unchecked stacking hurts:** Both are tweaking the same score on the same dimension (recency). Ebbinghaus bumps the stability parameter on read, which lengthens the effective τ. If the exponential decay is applied at query time with a fixed τ AND the stored stability is also being used, the two are fighting over how much weight age should have. Documented in the atlas entry's conflict field.
- **Policy:** Pick one as primary (exponential decay with a single τ is simpler); use the other (Ebbinghaus stability) as a tiebreaker or for items with very high access counts. Do not let both drive top-k directly.

### N3. Intent-classification front-gate + Sub-question fanout

- **Atlas entries:** Intent-classification front-gate (family 7, refuted); Sub-question fanout (family 3).
- **Why stacking doesn't rehabilitate:** The repo's intent-gate was refuted because classification accuracy caps the recall ceiling — 43% at whole-query granularity (kb_architecture_testing). Adding sub-question fanout on top doesn't help: the front-gate still runs on the outer query and filters the pool before any sub-question is even generated. The right intervention is to MOVE the classification to the sub-question level, not to stack fanout downstream of a broken gate.
- **Policy:** If using fanout, drop the outer-query intent gate. If the intent signal is valuable, classify each sub-question independently.

### N4. Atomic-fact extraction + Reflection rollup without ordering

- **Atlas entries:** Atomic-fact extraction (family 1); Reflection rollup (family 1); implicitly Contradiction supersession.
- **Why unchecked stacking hurts:** Reflection generates summaries from atoms. If supersession hasn't run first, the rollup will bake invalidated claims into a summary, and the summary will outlive the invalidation. The atlas notes this in the reflection entry's Conflicts field.
- **Policy:** Ordering is load-bearing. Run supersession on atoms BEFORE reflection, or re-run reflection after each supersession batch.

---

## Mechanical conflicts

### C1. Atomic-fact store vs. Community summaries — two memories of truth

- **Atlas entries:** Atomic-fact extraction (family 1); Community summaries (family 2).
- **Why they conflict:** They disagree on what a "memory unit" is. Atoms are claims; community summaries are cluster-level abstractions. A single retrieval-time ranker cannot coherently compare them — one is specific evidence, the other is synthesis. Running both means maintaining two indices and deciding per-query which to hit.
- **Resolution:** Keep both but route per query (specific questions hit atoms, global questions hit summaries — this is essentially LightRAG's dual-index logic lifted up a level). Alternatively pick one and accept the miss-mode it doesn't cover.

### C2. SYNAPSE tier-inhibition vs. Personalized PageRank

- **Atlas entries:** SYNAPSE refuted (family 7); Personalized PageRank (family 2).
- **Why they conflict:** Both are density models over the graph but with opposite temperament: SYNAPSE damps distant tiers with explicit inhibition; PPR damps them implicitly through walk return probability. Running both at the same time gives incoherent scores. The repo's phase 2.10 refutation is specific to SYNAPSE's tier-inhibition — it suggests PPR is the variant worth trying, not stacking.
- **Resolution:** Pick one. PPR is the open candidate given the phase 2.10 refutation.

### C3. Edge-hotness soft-gate vs. Ebbinghaus node-reinforcement

- **Atlas entries:** Edge-hotness soft-gate refuted (family 7); Ebbinghaus reinforcement (family 5).
- **Why they conflict:** Both bias toward "used" structure, but at different granularity (edges vs. nodes). Combining them double-counts access — a frequently-traversed path inflates both edge-hotness AND node-stability scores. Phase 4a refuted the edge side on eval-C latency. Node-side reinforcement is the open slot precisely because edge-side was refuted.
- **Resolution:** Use Ebbinghaus at the node level. Keep edge-hotness as an observable (phase 2.9 shows it exists) but not as a soft-gate.

### C4. Single-vector HNSW index vs. ColBERT late-interaction

- **Atlas entries:** ColBERT MaxSim (family 4); implicit single-vector HNSW infrastructure (commits 886a709, 6e815a8).
- **Why they conflict:** Late-interaction stores one vector per token, not per item. Standard HNSW indexes assume one vector per item. Running both requires two parallel indexes and doubles storage. For a framework that already invested in HNSW, adopting ColBERT means either a dual-index split (by domain or by retrieval tier) or swapping the base index structure.
- **Resolution:** Per-domain decision. KB might tolerate the dual-index cost if phase 2.15's encoder-granularity ceiling is the active bottleneck; Chat probably does not.
