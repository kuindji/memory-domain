# Prior-Art Index

Internal lookup mapping this repo's phase notes and commits to atlas entries. Populated from `~/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/` and `git log --since=2025-09-01 -- src/`. Referenced by atlas entries as their **Prior-art note** field.

Outcome legend: **W** = win/promoted, **N** = null result, **R** = refuted, **P** = partial / mixed, **D** = deferred.

---

## A. Path-memory phase work (graph retrieval + temporal)

### path_memory_phase28
- **Source:** `memory/path_memory_phase28.md`
- **Topic:** BGE-small re-sweep + Dijkstra tmp + weighted-fusion τ
- **Outcome:** W (default) — Dijkstra tmp=0.5, wfusion τ=0.2, decay OFF.
- **Mechanism:** path-aware graph traversal with weighted fusion of scores across hops; option M (alternative) regressed.
- **Likely atlas family:** 2 (graph), 4 (fusion/rerank).

### path_memory_phase29
- **Source:** `memory/path_memory_phase29.md`
- **Topic:** repeat-user access concentration
- **Outcome:** W — PASS 8/8 on edgeRatio ≥5× (mean 7.72×). Nodes flat, edges concentrate with repeat access; paths never repeat.
- **Mechanism:** edge-weight hotness emerges naturally from repeat access, without node-level access accumulation.
- **Likely atlas family:** 2 (graph), 5 (temporal — access recency).

### path_memory_phase210
- **Source:** `memory/path_memory_phase210.md`
- **Topic:** SYNAPSE spreading activation
- **Outcome:** R — eval-A regresses, eval-B flat. Small-graph dilution + tier-2 inhibition harm. Ships opt-in only.
- **Mechanism:** query-time activation spreads from anchor nodes to neighbors with tier-based inhibition.
- **Likely atlas family:** 2 (graph).

### path_memory_phase4a
- **Source:** `memory/path_memory_phase4a.md`
- **Topic:** edge-hotness soft-gate
- **Outcome:** R on eval-C. Holds eval-A/B exactly; eval-C latency +35%, flat coverage. Ships disabled-only.
- **Mechanism:** use per-edge access counts as a soft gate on traversal.
- **Likely atlas family:** 2 (graph).

### path_memory_phase211_deferred
- **Source:** `memory/path_memory_phase211_deferred.md`
- **Topic:** MAGMA per-view router
- **Outcome:** D — dry-run null (1 unique tuple across 38 tier-2 probes). Deferred until after Phase 7.
- **Mechanism:** router picks retrieval "view" (e.g. anchor set) per query.
- **Likely atlas family:** 3 (query decomposition / planning).

### path_memory_strategic_review
- **Source:** `memory/path_memory_strategic_review.md`
- **Topic:** strategic reorder 2026-04-17
- **Outcome:** plan — upgrade embedder, jump to Phase 3 access tracking, prune dead primitives.
- **Mechanism:** meta — informs prioritization.
- **Likely atlas family:** meta (applies to atlas prioritization, not a mechanism itself).

### path_memory_phase213
- **Source:** `memory/path_memory_phase213.md`
- **Topic:** BGE-base encoder promotion
- **Outcome:** W — tier-2 eval-B coherence 1/4 → 2/4 (first pass); sessionDecay ON by default.
- **Mechanism:** swap encoder to higher-dim retrieval model.
- **Likely atlas family:** (encoder choice — cross-cuts; mention in recipes).

### path_memory_phase214
- **Source:** `memory/path_memory_phase214.md`
- **Topic:** sessionDecayTau retune
- **Outcome:** W' — decay τ=0.2 lifts tier-2 eval-B coherence 2/4 → 3/4; τ=0.3 is edge of pass-band.
- **Mechanism:** exponential decay of memory access score by session age.
- **Likely atlas family:** 5 (temporal).

### path_memory_phase214_stage2
- **Source:** `memory/path_memory_phase214_stage2.md`
- **Topic:** Alexander-succession arc
- **Outcome:** N — byte-identical missing-claim signature across 9 rows; arc is encoder-granularity-bound.
- **Mechanism:** adding H (hub) + A1 (anchor-weighting) did not flip this arc. Ships per-arc claim diagnostic.
- **Likely atlas family:** (encoder-limit signal — informs ceiling statements).

### path_memory_phase215
- **Source:** `memory/path_memory_phase215.md`
- **Topic:** BGE-large retune
- **Outcome:** R — 13-row 1D sweep flat at 2/4 coherence; byte-identical bumps across 8 rows — anchor knobs are post-encoder-noise.
- **Mechanism:** larger encoder + retune of decay + τ. BGE-large is parity encoder for coherence; Dijkstra regresses.
- **Likely atlas family:** (encoder-limit signal + RRF motivation).

### path_memory_phase216
- **Source:** `memory/path_memory_phase216.md`
- **Topic:** same-family RRF (Stage A)
- **Outcome:** P — commit 2f9b63c. {BGE-base, BGE-large} RRF lifts tier-2 eval-A +0.053 / tier-1 eval-A +0.056 but regresses tier-2 coherence 3/4 → 2/4. k inert. Ships opt-in.
- **Mechanism:** reciprocal-rank-fusion across multiple encoder views.
- **Likely atlas family:** 4 (rerank / fusion).

### path_memory_phase75
- **Source:** `memory/path_memory_phase75.md`
- **Topic:** LOCOMO + MSC baselines
- **Outcome:** W (baseline established) — LOCOMO 12.6% contain / 32.1% evidR (1542 scored); MSC 33.2% persona recall (200 probes). Graph retrieval first shows external value on LOCOMO cat 2.
- **Mechanism:** full pipeline run against external benchmarks.
- **Likely atlas family:** (baseline — informs Silentium recipe).

### path_memory_phase76_candidates
- **Source:** `memory/path_memory_phase76_candidates.md`
- **Topic:** precision tuning after LOCOMO
- **Outcome:** candidates — failure shape is precision-limited (evidR 0.32 >> contain 0.13, tokenF1 0.02). Lower resultTopN + anchorTopK before touching retriever internals.
- **Mechanism:** tighten candidate pool size.
- **Likely atlas family:** 4 (rerank — precision).

---

## B. Inbox and atomic-fact work

### project_inbox_redesign
- **Source:** `memory/project_inbox_redesign.md`
- **Topic:** two-phase parallel inbox with similarity batching + claim assertion
- **Outcome:** design → implemented (see commits 4c255fc, 115c5bd).
- **Mechanism:** ingest pipeline that extracts atomic claims and batches similar items for supersession.
- **Likely atlas family:** 1 (atomic-fact extraction + supersession).

### inbox_error_handling
- **Source:** `memory/inbox_error_handling.md`
- **Topic:** bounded retries (2x), quarantine, stale recovery
- **Outcome:** W (policy) — hardens the ingest pipeline.
- **Mechanism:** retry + quarantine on inbox processing failures.
- **Likely atlas family:** 1 (atomic-fact — operational edge).

### similarity_batching
- **Source:** `memory/similarity_batching.md`
- **Topic:** groups by embedding + request context for batch processing
- **Outcome:** W (mechanism).
- **Mechanism:** cluster inbox items by embedding + context before LLM call so supersession decisions see related items together.
- **Likely atlas family:** 1 (atomic-fact — supersession).

### Relevant commits
- `4c255fc` — code-repo: atomic fact decomposition, supersession, importance-aware ranking.
- `115c5bd` — user: inbox processing with classification, supersession, importance-aware ranking.
- `a6f789f` — chat: deduplicate semantic memories during consolidation via LLM merge.
- `9d9c6ce` — chat: detect contradictions during consolidation via extractStructured.

---

## C. KB domain and decomposition

### kb_architecture_testing
- **Source:** `memory/kb_architecture_testing.md`
- **Topic:** traditional IR improvements + intent filtering
- **Outcome:** P — Traditional IR built; intent classification 43% (too low).
- **Mechanism:** per-intent candidate filtering before retrieval.
- **Likely atlas family:** 3 (decomposition / intent).

### kb_decomposition_next_steps
- **Source:** `memory/kb_decomposition_next_steps.md`
- **Topic:** A+B+C fix — keep parent + context-preserving facts + selective threshold
- **Outcome:** plan.
- **Mechanism:** atomic decomposition that retains parent link and context frame.
- **Likely atlas family:** 1 (atomic-fact + context preservation).

### kb_scoring_harness_location
- **Source:** `memory/kb_scoring_harness_location.md`
- **Topic:** harness lives in TheFloorr repo.
- **Outcome:** reference.
- **Likely atlas family:** (reference — informs KB recipe).

### Relevant commits
- `3309841` — KB: temporal validity, importance scoring, adaptive context, atomic decomposition.
- `aecc0e4` — query intent classification for KB.
- `26cbde7` — denormalize classification and topics onto memory records for DB filtering.
- `bfe91d0` — KB buildContext with intent-driven filtered search.
- `607d943` — LLM-based re-ranking of KB buildContext results.
- `af6c810` — embedding-based re-ranking for precision filtering.
- `be4d677` — make embedding and LLM rerank toggleable.
- `77e6484` — MMR budget filling + question-aware indexing.
- `91874db` — wire embedding rerank into KB buildContext.
- `106b0a3` — remove intent filters from search, add dedup aliases, drop unused LLM call.
- `5364f20` — fix keyword search retrieval + improve answer synthesis.
- `3b9f50b` — add supplemental BM25 content search to catch embedding rerank misses.
- `14aa61f` — replace BM25 supplemental with keyword CONTAINS search.
- `91a749b` (91a6350a?)  / `a55f2a5` — assert-claim sentinel parent for index-based inbox discovery.
- `776e1af` — topic-based score boosting in KB buildContext.
- `e4061c6` — dual-path search for better recall.
- `91a6350a` — path-memory HNSW indexing.

---

## D. Chat domain — temporal validity + semantic dedup

### docs/superpowers/specs/2026-04-12-chat-temporal-validity-and-semantic-dedup.md
- **Source:** spec in-tree.
- **Topic:** valid-time intervals + semantic dedup at consolidation.
- **Outcome:** implemented (commits 9a6350a, cbf9ea7, a6f789f, 9d9c6ce, d600b32, 9274ac3).
- **Mechanism:** `validFrom` / `invalidAt` on ChatAttributes + LLM-merge of near-duplicate semantic memories + contradiction detection on consolidation.
- **Likely atlas family:** 5 (temporal — valid-time), 1 (supersession via contradiction).

### Relevant commits
- `cbf9ea7` — add validFrom, invalidAt to ChatAttributes + semanticDedupThreshold.
- `9a6350a` — set validFrom on episodic memories during promotion.
- `d600b32` — skip invalidated memories during decay pruning.
- `9274ac3` — filter invalidated memories from buildContext.

---

## E. LM-as-memory and predictive-memory (closed / mixed lines)

### predictive_memory_phase1
- **Source:** `memory/predictive_memory_phase1.md`
- **Topic:** PARK — CMR + HMM on MSC
- **Outcome:** R — CMR Δ=+0.11pp (<< 2pp), HMM Δ=+0.022 (<< 0.05). Phase-0 wins were fixture artefacts. Line closed.
- **Mechanism:** context-maintenance retrieval + hidden-state memory models.
- **Likely atlas family:** (skipped per spec — predictive/world-model line closed).

### lm_as_memory_phase04
- **Source:** `memory/lm_as_memory_phase04.md`
- **Topic:** GRACE — Qwen2.5-1.5B + MPS
- **Outcome:** P — 23/23 exact-form, 0/20 Q&A-form. Codebook learned perfectly; L2 lookup defeated by template wrapping. Parametric line survives.
- **Mechanism:** key-value parametric memory with learned codebook.
- **Likely atlas family:** (parametric memory — not in current family set; flag as Phase-0.5 candidate).

---

## F. Plugin architecture and infrastructure

### Relevant commits
- `e2b816a` — add topic-linking plugin extracting shared cross-domain logic.
- `a698f3c` — engine: plugin registration, validation, lifecycle hooks.
- `a0fbb1c` — plugin type definitions for domain plugin system.
- `b98b09d` — cache afterTopicLink attr mutations + add `memory.topics` field.
- `cb9ccbe` — topic-linking vector-only mode for Tier-C dedup.
- `57ffca4` — topic-linking Tier 0 stable-id lookup.
- `0816d87` — CachedEmbeddingAdapter memoizing deterministic embeddings.
- `886a709` — enable HNSW index usage for vector search.
- `6e815a8` — ensure HNSW index correct dimension.
- `2762003` — index relation edge in/out fields + fix graph tag search.
- `9ca1dd7` — batch getMemoryTags, rewrite getTagDescendants, add index verifier.
- `2249076` — perf: cut WDI ingestion ~47% via topic-linking tiers.

These are framework primitives — not atlas entries themselves but referenced by recipes.

---

## G. Feedback entries (operational rules, not atlas entries)

- `feedback_exhaust_non_llm_first.md` — default to rule-based scoring, retrieval geometry, corpus-shape experiments until non-LLM options exhausted.
- `feedback_sonnet_over_haiku.md` — prefer sonnet for quality-sensitive scripted calls; haiku for plumbing only.
- `feedback_plan_must_position_prior_art.md` — plans need explicit "Relation to existing systems" section.

Referenced by the spec and plan, not by atlas entries.

---

## H. External survey

### ai_memory_systems_landscape
- **Source:** `memory/ai_memory_systems_landscape.md`
- **Topic:** Mem0 / Zep / Letta / Cognee patterns
- **Outcome:** survey.
- **Mechanism:** atomic facts, tiered memory, temporal supersession.
- **Likely atlas family:** 1 (atomic-fact), 5 (temporal). This entry seeds the external paper reading in Tasks 3, 7.

---

## Silentium — pending user input

Not sweepable from this session (separate repo). If the user provides the Silentium repo path, this section is populated in a follow-up pass. For now, atlas entries that claim Silentium applicability flag their prior-art note as "Silentium — sweep pending".
