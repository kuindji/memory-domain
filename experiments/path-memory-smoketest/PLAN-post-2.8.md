# Path-Memory Post-Phase-2.8 Roadmap Update

## Context

Phase 2.8 shipped a new default (Dijkstra `tmp=0.5` + weighted-fusion `τ=0.2`,
session-decay off) and landed Phase 3 access-tracking instrumentation. Eval-A
lifted to 0.703 tier-1 / 0.627 tier-2. Two Phase-2.8 results constrain what
comes next:

1. **Access is uniformly flat.** Under both eval-A scatters and eval-B 4-turn
   traces, top-5 node share is ≈2.3% on tier-2 (uniform baseline 2.1%). The
   Phase-4 naïve design ("cache frequently accessed paths") has nothing to
   cache on this corpus shape. Phase 3 was only partially exercised — user
   halted it for cost reasons — but the flat-access pattern is robust across
   what was run.
2. **The Phase-2.6 Option M lift is encoder-stale.** Under BGE-small the
   α=0.5 idf-weighted-fusion regresses eval-A to 0.443/0.443. MiniLM-era
   anchor-scoring tuning does not port.

A parallel research scan (Apr 2026) surfaced six directly-relevant 2026
works, three of which are close methodological cousins to the smoke-test
and one of which (SYNAPSE) directly addresses the Phase-3 flat-access
negative result.

The strategic review (`path_memory_strategic_review`) item #1 (upgrade
embedder) is done; #2 (access tracking) is partially done with a negative
result on the naïve cache hypothesis; #3 (prune dead primitives) needs
re-issuing under BGE-small (L, M α≥0.5, A1, H now prune candidates); #4
(success conditions) now tags at B — eval-A lifts structurally, eval-B
coherence ceiling remains embedding-layer-bounded.

This plan proposes the next four phases (2.9 → 2.12), a redesign of
Phase 4 conditional on upstream phases, and a retarget of Phase 7 from
bespoke Wikipedia tier-3 to LongMemEval. Prior work and position are
stated explicitly in the "Relation to existing systems" section.

## Status (as of 2026-04-17)

| Phase | State | Headline outcome |
|---|---|---|
| **2.9** Corpus-shape (Option R) | **DONE** (commit `01e1532`) | **PASS 8/8** on edgeRatio ≥ 5× uniform (mean 7.72×). Nodes stay flat (nodeRatio ≈ 1.00), edges concentrate sharply, path-as-returned signatures never repeat (0/40 sessions). Path-keyed Phase-4 design is retired; edge-hotness cache + Phase-2.10 activation profile are the real targets. |
| **2.10** Spreading activation (Option O) | **KILLED — opt-in only** | Best Option O: 0.682 tier-1 / 0.522 tier-2 vs Phase 2.8 baseline 0.703/0.627 (regress -0.021/-0.105). Eval-B coherence flat at 1/4 (target 2/4). Inhibition load-bearing on tier-1 (β=0 drops 0.682→0.536) but slightly *hurts* tier-2 — small-graph dilution + tier-2 failure modes ≠ vocabulary-distractor. Ships as `AnchorScoring.kind = "spreading-activation"`; defaults unchanged. See CONTEXT.md § Phase 2.10. |
| **2.11** Per-view routing (Option P) | **NEXT** | Promoted — remaining architectural hypothesis is that single-adjacency merge of temporal/lexical/semantic discards routing signal. Open question: do Phase 7 first to test 2.10's "small-graph dilution" hypothesis at LongMemEval scale? |
| **2.12** Differentiable scorer (Option Q) | Deferred | Unchanged. |
| **Phase 4** Cache | **Reverted to 4a only** | 4b activation-persistence is dead (no Option O activation profile to persist). 4a edge-hotness cache remains the only live cache shape. |
| **Phase 7** LongMemEval retarget | Possibly NEXT before 2.11 | Also serves as the scale-generalization check for both 2.9 (edge concentration) and 2.10's small-graph dilution argument. |

**Key 2.9 interpretation** (full details in `CONTEXT.md` § "Phase 2.9" and memory `path_memory_phase29.md`):

- The graph has a natural **highway structure** — a small edge subset carries most traversal bumps under repeat-user traffic, while node coverage stays saturated. This matters for tuning Phase 2.10's lateral-inhibition: activation will ride these highways by default, and `lateralInhibitionTau` / `inhibitionStrength` need to be strong enough to push *off* them when the probe demands within-cluster differentiation.
- "Caching paths" was never going to work on this architecture; "pruning against a hot edge set" plausibly will.

**Open strategic question for next session:** commit straight to Phase 2.10, or run a minimal edge-hotness pre-experiment first (maybe half a session — wire a `hotEdgeTopK` filter into Dijkstra, measure eval-A + latency) as cheap insurance against Option O subsuming the signal? See "Ordering" below for the recommended sequence.

## Relation to existing systems

All six works were surfaced in the Apr 2026 research scan; this plan
cites each only where it's methodologically load-bearing.

| Work | URL | Where it enters this plan | How we differ |
|---|---|---|---|
| **SYNAPSE** (arXiv:2601.02744, Feb 2026) — spreading activation + lateral inhibition + temporal decay over unified episodic-semantic graph, LoCoMo SOTA | https://arxiv.org/abs/2601.02744 (HTML: https://arxiv.org/html/2601.02744v2) | **Basis for Phase 2.10 (Option O).** We take spreading activation and lateral inhibition as anchor-layer primitives | SYNAPSE makes activation the retrieval substrate itself (Triple Hybrid Retrieval). We keep Dijkstra traversal and use activation only to rerank/prune the anchor set — cheaper, composable with existing primitives, and directly testable against the specific tier-2 failure modes (vocabulary distractor, within-cluster granularity) |
| **MAGMA** (arXiv:2601.03236, Jan 2026) — four orthogonal graphs (semantic/temporal/causal/entity) + intent-aware router + subgraph fusion, 95% token reduction on LongMemEval | https://arxiv.org/abs/2601.03236 (HTML: https://arxiv.org/html/2601.03236v1) | **Basis for Phase 2.11 (Option P).** We take per-edge-type view separation + probe-conditional routing | MAGMA builds four graphs from the start. We already have three edge types (temporal / lexical / semantic) in a single adjacency; we'd split the adjacency and add a cheap router, keeping all other primitives intact. Minimum-viable MAGMA |
| **S-Path-RAG** (arXiv:2603.23512, Mar 2026) — weighted k-shortest + beam + constrained random walk + differentiable path scorer + verifier; WebQSP 88.9 Hit@1 | https://arxiv.org/abs/2603.23512 (HTML: https://arxiv.org/html/2603.23512v1) | **Basis for Phase 2.12 (Option Q).** We borrow the differentiable scorer idea | S-Path-RAG's full pipeline (iterative Neural-Socratic refinement) includes LLM calls; we specifically keep the memory layer LLM-free. We borrow only the learned scorer for the already-computed breakdown features (probeCoverage, edgeTypeDiversity, etc.) |
| **Memento** (Apr 2026) — bitemporal KG + entity resolution + contradiction detection; 92.4% LongMemEval | Blog: https://explore.n1n.ai/blog/building-bitemporal-knowledge-graph-llm-agent-memory-longmemeval-2026-04-11 · Repo: https://github.com/shane-farkas/memento-memory · Benchmarks: https://github.com/shane-farkas/memento-memory/blob/main/BENCHMARKS.md | **External bar.** Sets target for Phase 7 retarget | Memento uses LLM-driven entity resolution and contradiction detection; our bitemporal-light is pre-authored. Direct benchmark comparison, not a primitive to copy |
| **Zep / Graphiti** (arXiv:2501.13956, Jan 2025) — temporal KG with bi-temporal (event-time + ingestion-time), LongMemEval 71.2% | https://arxiv.org/abs/2501.13956 | **External bar** for Phase 7 retarget; frames the bitemporal-light position | Zep uses LLM-driven fact extraction; ours is pre-authored. Comparison target only |
| **CompassMem** (arXiv:2601.04726, Jan 2026) — Event Segmentation Theory → event graph with explicit logical relations | https://arxiv.org/abs/2601.04726 (HTML: https://arxiv.org/html/2601.04726v1) | **Cited in framing only.** Reinforces "retrieved path *is* the answer" stance | We don't add logical-relation edge types; our edge types remain structural (temporal/lexical/semantic) |
| **ColBERT-Att** (arXiv:2603.25248, Mar 2026) — attention-weighted MaxSim (term importance in late interaction) | https://arxiv.org/abs/2603.25248 | **Noted, not a basis.** Was initially Option-M-validating; Option M is encoder-stale under BGE-small, so ColBERT-Att's relevance is now theoretical only |
| **LongMemEval** (arXiv:2410.10813, ICLR 2025) — long-term conversational memory benchmark used by Memento / Zep / MAGMA | https://arxiv.org/abs/2410.10813 | Target corpus for Phase 7 retarget | We'd adapt our retriever to the question format, not modify the benchmark |
| **LoCoMo** — long conversation memory benchmark used by SYNAPSE / MAGMA / CompassMem | Referenced in SYNAPSE and MAGMA papers above | Secondary target for Phase 7 retarget | Same as LongMemEval — adapter work only |

## Phase 2.9 — Corpus-shape experiment (Option R, small) — **DONE 2026-04-17**

**Outcome.** PASS 8/8 traces on edgeRatio ≥ 5× uniform (mean 7.72×, range 5.53–10.28). Nodes uniformly accessed (nodeRatio ≈ 1.00) but edges concentrate sharply. Top-3 path-node-set signatures never repeated across 40 sessions (repeatingPaths = 0 on every trace). Ships `eval/traces-repeat-user.ts` + `eval/eval-c-access.ts`; findings in `CONTEXT.md` § "Phase 2.9"; commit `01e1532`.

**What this settles.**
- Phase 4 (path-keyed cache shape) is **retired** — zero hit rate by construction.
- Phase 4 (edge-hotness shape) **has a target** — a small subset carries disproportionate traversal.
- Phase 2.10 (Option O) priority holds; its motivation doubles — activation profile = persistence substrate for the measured edge concentration.

Original plan preserved below for traceability.

---

**Read before implementing.** No directly-derivative paper — this phase
is an internal eval-shape experiment responding to Phase 3's flat-access
finding. Background reading is optional but useful:
- SYNAPSE's LoCoMo evaluation setup (multi-session traces) —
  https://arxiv.org/html/2601.02744v2 (§ Experiments / LoCoMo section)
- LongMemEval benchmark construction —
  https://arxiv.org/abs/2410.10813 (§ "Session structure")
Use both to inform the trace design; do not copy verbatim (we want our
eval to surface concentration, not match an external benchmark).

**Why.** Phase 3's flat-access result was measured on synthetic query
scatters (12 eval-A / 19 eval-A) and 3–4-turn topical arcs. Real agent
memory use is dominated by **repeat-user sessions**: the same user
returning with overlapping but evolving questions across many sessions.
Concentration may emerge only under that traffic shape. Without this
test, we can't tell whether Phase 4 is premature *always* or only *on
our current eval*.

**Scope.** ~6–10 multi-session conversation traces where each session
is 3–6 turns and sessions revisit overlapping clusters (e.g., session 1
"Plato's dialogues"; session 3 "Plato vs Aristotle"; session 5 "Plato's
influence on Neoplatonism"). Target 25–40 turns total per trace.

**Deliverable.** New eval-C in `eval/`. Phase-2.8 default config
re-run with existing Phase-3 access-tracking on. Report:
- Does top-5 node share exceed the uniform baseline?
- Does top-5 edge share show a heavy tail (target: >5× uniform)?
- Do specific paths repeat across sessions within a trace?

**Pass criterion.** Top-5 edge share ≥ 5× uniform baseline on at
least half of traces. If yes → Phase 4 has real signal, proceed to
design the cache keyed on probe clusters. If no → the well-worn-path
architectural claim is under tension, not just tuning.

**Cost.** 1 session. No core code changes — only new trace data and
an eval runner.

**Files touched.** `experiments/path-memory-smoketest/eval/traces-repeat-user.ts`
(new), `eval/eval-c-access.ts` (new), `CONTEXT.md` findings section.

## Phase 2.10 — Option O: SYNAPSE-inspired activation reranker (medium, primary research bet)

**Read before implementing.** REQUIRED reading — this phase adapts
SYNAPSE's primitives.
- **SYNAPSE paper** — https://arxiv.org/abs/2601.02744
- **SYNAPSE HTML (easier skim)** — https://arxiv.org/html/2601.02744v2
- **Paper overview / interpretation** —
  https://www.alphaxiv.org/overview/2601.02744v1
- **HuggingFace paper page** —
  https://huggingface.co/papers/2601.02744

Focus on: (1) the spreading activation formula and its decay parameter,
(2) the lateral inhibition mechanism (how cross-node suppression is
computed and when it's applied in the loop), (3) the Triple Hybrid
Retrieval section (to understand what we're NOT copying — we stop at
reranker, SYNAPSE goes further). Take notes on how they bound
activation-set size and handle runaway activation; replicate those
guards in Option O.

Secondary — on lateral-inhibition-as-primitive from cognitive science:
- "Synapse: Empowering LLM Agents" CatalyzeX summary —
  https://www.catalyzex.com/paper/synapse-empowering-llm-agents-with-episodic

**Why.** SYNAPSE's spreading activation + lateral inhibition directly
attacks the two specific tier-2 failure modes Phase 2.4 diagnosed:

- **Vocabulary distractor** (e.g., `pw_pausanias_commands` surfacing on
  "generals"). Lateral inhibition among activated anchors suppresses
  `pw_pausanias_commands` once a higher-activation diadoch-cluster anchor
  is selected, because they share enough embedding proximity to trigger
  inhibition.
- **Within-cluster granularity** (late-Peloponnesian events fighting
  each other). Activation differentiates neighbors by **hop distance and
  edge weight**, not cosine alone — so `pwar_aegospotami` reached via a
  coherent temporal + lexical path gets higher activation than a
  tangentially-related same-cluster claim reached only via semantic
  similarity.

This is also our best shot at producing **dynamic concentration** that
static access counters couldn't find. Activation state accumulates
across turns; the cache becomes "activation profile" rather than
"access counts."

**Design.**

New `AnchorScoring.kind = "spreading-activation"`:

```ts
{
  kind: "spreading-activation";
  initialTopK: number;           // e.g., 5 — seed anchors via cosine
  maxHops: number;               // e.g., 2 — activation propagation depth
  decay: number;                 // e.g., 0.7 — per-hop activation attenuation
  lateralInhibitionTau: number;  // e.g., 0.6 — cosine threshold at which
                                 // two anchors inhibit each other
  inhibitionStrength: number;    // e.g., 0.5 — how much suppression
  useSessionWeights?: boolean;
}
```

**Algorithm.**
1. Seed: top-`initialTopK` claims by per-probe weighted cosine (reuse
   Phase-2.1 default aggregation).
2. Propagate: for `hop ∈ [1..maxHops]`, for each currently-activated
   node, distribute `decay · activation(node) · edgeWeight` to neighbors
   via `GraphIndex.neighbors()`. Accumulate activation on each reached
   node. (Edge-type-aware: temporal gets `temporalHopCost`-like damping
   to prevent timeline-highway; lexical/semantic use edge.weight.)
3. Lateral inhibition: sort activated nodes by activation descending.
   For each node `c` in order, scan remaining nodes; if
   `cosine(c, c') > lateralInhibitionTau`, subtract
   `inhibitionStrength · activation(c')` from `activation(c'')`. Single
   pass (O(K²) on activated set, bounded by initialTopK · maxHops · fanout).
4. Re-rank: take top-K of post-inhibition activation as the final
   anchor set.

**Natural code extension point.** Per the Explore mapping, anchor-scoring
variants dispatch at `retriever.ts:82-91`. The new branch reuses
`GraphIndex.neighbors()` (graph.ts:85-90) for propagation. No graph
refactor needed. Lateral inhibition reuses the embedding access already
present in anchor scoring (cosine similarity is computed per anchor
already).

**Deliverable.**
- New anchor-scoring branch + 6–8 unit tests (seed-only collapse to
  cosine, 2-hop propagation, lateral inhibition suppresses duplicates,
  decay=0 collapses to seed, decay=1 full activation).
- Sweep: `initialTopK ∈ {3, 5, 8}` × `maxHops ∈ {1, 2, 3}` × `decay ∈
  {0.5, 0.7, 0.9}` × `lateralInhibitionTau ∈ {0.5, 0.6, 0.7}`. Promote
  best to eval-B full run.

**Pass criterion.**
- Eval-A: tier-1 ≥ 0.703 (hold Phase 2.8 default) and tier-2 ≥ 0.627.
- Eval-B: tier-2 coherence ≥ 2/4 (Phase 2.1's best-ever was 1/4; Option
  M under MiniLM reached 2/4 but is now stale — Option O is the only
  primitive that could plausibly repeat that).

**Kill criterion.** If best sweep config regresses eval-A by >0.02 on
both tiers *and* doesn't lift eval-B coherence, ship as opt-in
infrastructure and move to Phase 2.11.

**Cost.** 2–3 sessions. Primary research bet of this update.

**Files touched.**
- `src/retriever.ts` — new `composeAnchorsSpreadingActivation` function
  (parallel to existing seven, ~80 lines)
- `src/graph.ts` — expose `neighbors(id, types?, weighted?)` signature
  refinement if needed
- `tests/retriever.test.ts` — new suite
- `eval/sweep.ts`, `eval/iterative-sweep.ts` — Phase-2.10 rows
- `CONTEXT.md` — new findings section

## Phase 2.11 — Option P: MAGMA-inspired per-view routing (medium, contingent)

**Read before implementing.** REQUIRED reading — this phase adapts
MAGMA's multi-view architecture.
- **MAGMA paper** — https://arxiv.org/abs/2601.03236
- **MAGMA HTML** — https://arxiv.org/html/2601.03236v1
- **HuggingFace paper page** —
  https://huggingface.co/papers/2601.03236
- **AlphaXiv overview** —
  https://www.alphaxiv.org/overview/2601.03236v1
- **Moonlight literature review** (good for "how does the router
  work" summary) —
  https://www.themoonlight.io/en/review/magma-a-multi-graph-based-agentic-memory-architecture-for-ai-agents

Focus on: (1) how the four orthogonal graphs are constructed (they
use LLM extraction; we're keeping ours structural — understand the
delta), (2) the Adaptive Traversal Policy / intent router (this is
what we copy in simplified form — no LLM), (3) the subgraph fusion
step at the end (how results from different views are reconciled
into a single ranked list). Open question to answer from the paper:
does MAGMA's router operate on query *features* (token patterns,
embedding properties) or on an LLM intent classification? We want
the former — confirm it's extractable.

Secondary — agent-memory survey context:
- "Graph-Based Agent Memory: A Complete Guide" —
  https://shibuiyusuke.medium.com/graph-based-agent-memory-a-complete-guide-to-structure-retrieval-and-evolution-6f91637ad078

**Why.** If Phase 2.10 refutes or only partially lifts, the remaining
architectural hypothesis is that merging three edge types into a single
adjacency matrix discards useful signal. MAGMA's central claim is that
per-edge-type traversal with intent-aware routing beats unified
traversal — and their 95% token reduction on LongMemEval is strong
evidence.

**Design.**

Split `GraphIndex.adjacency: Map<ClaimId, Edge[]>` into per-type
adjacencies: `temporalAdj`, `lexicalAdj`, `semanticAdj`. Add a cheap
per-probe router:

```ts
type ViewWeights = { temporal: number; lexical: number; semantic: number };

// Router heuristic (no LLM):
//  - probe contains year-like tokens or 'when'/'after'/'before' → temporal ↑
//  - probe embedding has high variance across corpus (generic) → semantic ↑
//  - probe tokens have high IDF-mass → lexical ↑
// Combine into ViewWeights summing to 1.
```

Traversal runs per view separately with view-specific `temporalHopCost`
/ `weightedFusionTau`. Results fuse by path-score weighted by the view's
router weight.

**Scope.** Larger refactor than Option O — touches graph storage and
traversal, not just anchor scoring.

**Pass criterion.**
- Eval-A tier-2 ≥ 0.647 (+0.02 over Phase 2.8).
- Optional bonus: per-query latency lift from view-scoped traversal
  (MAGMA reports 40% speedup).

**Cost.** 3–4 sessions. Only if Phase 2.10 doesn't decisively resolve
tier-2 eval-B.

**Files touched.** `src/graph.ts` (adjacency refactor), `src/retriever.ts`
(traversal dispatch per view), new `src/view-router.ts`, eval harness.

## Phase 2.12 — Option Q: Differentiable path scorer (large, deferred)

**Read before implementing.** REQUIRED reading — borrows from
S-Path-RAG's learned path scorer.
- **S-Path-RAG paper** — https://arxiv.org/abs/2603.23512
- **S-Path-RAG HTML** — https://arxiv.org/html/2603.23512v1
- **PDF (for scorer architecture diagrams)** —
  https://arxiv.org/pdf/2603.23512
- **Gist.Science summary** —
  https://gist.science/paper/2603.23512

Focus on: (1) the differentiable path scorer architecture and the
contrastive path encoder — they train jointly; we'll likely need to
train them sequentially given our scope, (2) the feature set the
scorer consumes (theirs uses learned path embeddings; ours would use
our hand-engineered breakdown features — confirm whether this is a
meaningful downgrade), (3) the verifier module — this is LLM-based
in S-Path-RAG and is explicitly out of scope for us (see
"Relation to existing systems" above).

Secondary — for the "learned scorer beats hand-tuned" baseline:
- "Retrieval-Augmented Generation for Multi-Hop QA Based on
  Structured Planning" (ACM TKDD) —
  https://dl.acm.org/doi/10.1145/3789506

**Why.** Path scoring at `retriever.ts:133` is a hand-tuned linear sum
of five features with weights frozen since Phase 1. S-Path-RAG shows a
learned path scorer beats hand-tuned on WebQSP/CWQ. We already compute
the breakdown once per path; replacing the linear sum with a learned
function is a surgical change.

**Design.** Train an XGBoost regressor (or small MLP — we can stay
ONNX-runtime-only) on tier-1 + tier-2 + (if Phase 2.9 produces it)
repeat-user eval. Features: the five existing breakdown terms +
path length, number of edges per type, mean edge weight, min edge
weight, max cosine-to-any-probe. Label: binary "in ideal set" from
eval-A gold.

**Prerequisites.**
- More labeled data than tier-1 + tier-2 currently provide. Phase 2.9
  should be done (new traces) or Phase 7 retargeted (LongMemEval gold).
- At least one of Phase 2.10/2.11 should have landed so we know which
  anchor-scoring primitive the learned scorer runs on top of.

**Pass criterion.** Eval-A tier-2 +0.03 over best hand-tuned config,
on held-out 20% of queries.

**Cost.** 3–4 sessions (training infra + eval + generalization checks).
Deferred; only worth spending if eval-A at the post-2.10/2.11 ceiling
still leaves meaningful ground on the held-out set.

## Phase 4 redesign — **updated post-2.9**

Original Phase 4: "cache frequently-accessed paths." **Retired** — Phase 2.9 confirmed `repeatingPaths = 0` across all 40 repeat-user sessions. A path-keyed cache has zero hit rate by construction.

Phase 2.9 did produce strong concentration at the **edge** level (mean edgeRatio = 7.72× uniform), so Phase 4 has a real target. Two live sub-options, not mutually exclusive:

- **4a — Edge-hotness cache (standalone, small).** Maintain a rolling "hot edge" set per active cluster/session context (top-K edges by recent access count, K ≈ 50–200). Use it to prune Dijkstra's traversal frontier: expand hot edges fully, gate cold edges behind a higher threshold. Cheap to implement (~50 lines in `retriever.ts`, one new config option) and directly testable against eval-A for regressions + latency win. Good candidate for "insurance pre-experiment" before Phase 2.10.

- **4b — Activation-profile persistence (subsumed by 2.10).** If Phase 2.10 lands with spreading activation + lateral inhibition, persist the activation vector across sessions with a decay schedule. The activation vector *is* the cache — hot regions emerge from accumulated activation, no separate edge store needed. This is the cleaner long-term shape if Option O validates.

**Decision rule.** If Phase 2.10 lands decisively (eval-A held + eval-B coherence ≥ 2/4), skip 4a and ship 4b as the persistence layer. If Phase 2.10 stalls or only partially lifts, 4a becomes a standalone shippable primitive.

**Cheapest insurance** (optional, half-session): run 4a as a pre-experiment *before* Phase 2.10. Confirms the hot-edge prune hypothesis empirically, gives us a measurable latency baseline for 2.10/2.11 to beat, and is reversible if Option O subsumes. Tradeoff: adds a session and delays the primary research bet.

## Phase 7 retarget — LongMemEval / LoCoMo instead of bespoke tier-3

**Read before implementing.** REQUIRED reading — this is a benchmark
adapter phase, so the benchmark papers are the spec.
- **LongMemEval paper (ICLR 2025)** —
  https://arxiv.org/abs/2410.10813 · PDF: https://arxiv.org/pdf/2410.10813
- **Memento case study (92.4% on LongMemEval)** — primary scoring
  target and adapter reference —
  https://explore.n1n.ai/blog/building-bitemporal-knowledge-graph-llm-agent-memory-longmemeval-2026-04-11
- **Memento implementation repo** (for adapter reference) —
  https://github.com/shane-farkas/memento-memory
- **Memento benchmark methodology** —
  https://github.com/shane-farkas/memento-memory/blob/main/BENCHMARKS.md
- **Zep/Graphiti paper (for scoring methodology + 71.2% baseline)** —
  https://arxiv.org/abs/2501.13956 · PDF: https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf
- **LoCoMo reference** (for Phase 7.5 secondary target) — referenced
  in SYNAPSE and MAGMA papers; find their eval setup sections

Focus on: (1) the five LongMemEval task categories (temporal reasoning,
knowledge updates, multi-session recall, preference tracking, abstention)
and which of our primitives address which, (2) the question-answering
format — we output paths, not answers, so we need an adapter (likely a
trivial context-building step; confirm scope before blocking this on
Phase 6), (3) the scoring methodology (GPT-4o-as-judge is standard;
confirm whether we need identical judge model for apples-to-apples
against Memento/Zep).

**Why.** The tier-3 Wikipedia corpus plan predates the maturity of
LongMemEval (ICLR 2025). As of Apr 2026, Memento reports 92.4%, Zep
71.2%, MAGMA 61.2%, and SYNAPSE shows LoCoMo SOTA. Re-running path-memory
on LongMemEval gives:

- Direct comparability to every peer system.
- External review-grade benchmark if this ever gets written up.
- Sidesteps the Wikipedia corpus authoring cost (originally estimated
  as its own session of work).

**Trade-off.** We lose the "disparate Wikipedia topics" stress test of
the architecture's scale behavior. Resolution: retain the bespoke
tier-3 as an optional Phase 7.5 for scale-specific observations (ANN
index, storage engine) — decoupled from evaluation.

**Cost.** 1 session to build the LongMemEval harness adapter; then
runs per phase become cheap.

## Ordering

| # | Phase | Scope | State | Blocks |
|---|---|---|---|---|
| 1 | **2.9** Corpus-shape experiment (Option R) | Small | **DONE** (PASS 8/8) | — |
| 2a | **4a pre-experiment** Edge-hotness prune (optional) | Small (½ sess.) | Not started | Provides latency baseline + validates prune hypothesis before 2.10 |
| 2 | **2.10** Spreading activation (Option O) | Medium | **NEXT** | Primary research bet; may subsume Phase 4 |
| 3 | **2.11** Per-view routing (Option P) | Medium | Pending | Only if 2.10 doesn't resolve tier-2 eval-B |
| 4 | **7 retarget** LongMemEval harness | Small | Pending | Enables external comparison + gives Phase 2.12 labels; also re-measures 2.9 edge-concentration at scale |
| 5 | **2.12** Differentiable scorer (Option Q) | Large | Deferred | Only after 2.10/2.11 + Phase 7 |
| 6 | **Phase 4** (4a standalone or 4b via 2.10) | Small–medium | Shape decided (see § "Phase 4 redesign") | Execution depends on 2.10 outcome |

**Recommended next-session entry point:** Phase 2.10 directly. The 4a pre-experiment is genuine optionality — worth it only if we want a latency baseline before 2.10 or if risk-aversion about 2.10 subsuming the signal dominates. Default = skip 4a, go to 2.10.

Do not commit to 3/4/5 until 2.10 lands.

## Dead primitives (re-issued under BGE-small)

Prune from future sweep matrices by default; retain as opt-in
infrastructure:

- Option L (`anchorTopK ≥ 10`)
- Option M (`idf-weighted-fusion` α ≥ 0.5) — encoder-stale
- Option A1 (`temporalDecayTau`) — inert to harmful
- Option H (`cluster-affinity-boost`) — no lift
- Option J (`density-coverage-bonus`, `min-cosine-gate`) — refuted

`sessionDecayTau` stays in the off-by-default position from Phase 2.8.

## Success conditions (re-tagged)

Revising strategic-review item #4:

- **Eval-A**: Hold Phase 2.8 baseline (0.703 / 0.627) at every new
  default. Any regression > 0.02 is a blocker.
- **Eval-B coherence**: The current ceiling (tier-2 1/4) is the
  north-star metric. Moving to 2/4 is the Phase-2.10 pass criterion;
  moving to 3/4 would be publishable.
- **Concentration**: Phase 2.9 produces top-5 edge share ≥ 5× uniform,
  or the naïve Phase-4 architecture claim is retired.
- **External comparability**: Phase 7 retarget produces at least one
  LongMemEval score by end of roadmap.

## Reading protocol (applies to every phase)

Before writing a single line of code for a phase:
1. Open the "Read before implementing" section for that phase and
   fetch every URL listed. Prefer the arXiv HTML version; fall back
   to PDF only if HTML is missing or broken.
2. Write a 200–400-word reading note summarizing (a) the mechanism
   we're borrowing, (b) what in the paper we're explicitly NOT
   copying, (c) implementation-critical details (hyperparameter
   defaults, bounds, failure modes the paper reports). Save as
   `experiments/path-memory-smoketest/notes/phase-2.N-reading.md`.
3. Only after the reading note is written, open the code and begin
   implementation. The reading note goes in the commit alongside
   code changes so future sessions can trace the primitive back to
   its source.
4. If a paper's primary URL is broken, try the alphaXiv mirror
   (`https://www.alphaxiv.org/overview/<arxiv-id>v1`), the
   HuggingFace paper page (`https://huggingface.co/papers/<arxiv-id>`),
   or the Moonlight literature review
   (`https://www.themoonlight.io/en/review/<slug>`). All three are
   listed in the per-phase reading blocks where available.

## Verification

For each phase, before marking done:

- Reading note exists at `notes/phase-2.N-reading.md` and is
  referenced in the commit message
- `bun lint`, `bun typecheck`, `bun format` — clean
- `bun test` at `experiments/path-memory-smoketest/` — all pass
- Main-repo `bun test` — no regressions beyond pre-existing flakes
- Eval-A sweep run vs Phase 2.8 default — table in `CONTEXT.md`
- Eval-B sweep run on promoted configs — table in `CONTEXT.md`
- New `path_memory_phaseXX` memory file + MEMORY.md pointer
- Commit message referencing this plan file by name

## Critical files

Touched across the roadmap (with expected line-count deltas):

- `src/retriever.ts` — +~100 lines for Option O anchor scorer; later
  refactor for Option P view dispatch
- `src/graph.ts` — possible `neighbors()` signature refinement for O;
  larger per-type adjacency refactor for P
- `src/view-router.ts` (new, Phase 2.11 only)
- `eval/sweep.ts`, `eval/iterative-sweep.ts` — Phase-2.N rows
- `eval/traces-repeat-user.ts` (new, Phase 2.9)
- `eval/eval-c-access.ts` (new, Phase 2.9)
- `eval/longmemeval-adapter.ts` (new, Phase 7)
- `CONTEXT.md` — findings sections per phase
- `~/.claude/plans/` — per-phase plan files matching
  `swirling-churning-spindle` / `temporal-churning-dijkstra` style
