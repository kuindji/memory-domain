# Phase 2.10 reading note — SYNAPSE (arXiv:2601.02744v2)

Source: https://arxiv.org/html/2601.02744v2 (fetched 2026-04-17, supplemented by alphaXiv overview and HuggingFace paper page).

## What we are borrowing

**Spreading activation as a re-ranker over the seed anchor set.** SYNAPSE seeds activation on nodes selected via dual triggers (BM25 + dense); we seed on the existing per-probe weighted-cosine top-K (Phase-2.1 default aggregation). Their per-hop propagation rule (their Eq. 2) is:

```
u_i(t+1) = (1 − δ)·a_i(t) + Σ_{j ∈ N(i)}  S · w_ji · a_j(t) / fan(j)
```

with paper defaults `S = 0.8` (spreading factor), `δ = 0.5` (per-hop retention), `T = 3` propagation iterations, `fan(j) = out_degree(j)` (the "fan-effect" attention dilution that prevents hub nodes from drowning everything else). Edge weights `w_ji` come from the existing edge type — for temporal edges they use `exp(−ρ|τ_i−τ_j|)` with `ρ = 0.01`; for semantic edges, cosine. We already store equivalents on `Edge.weight` (lexical IDF-Jaccard, semantic cosine, temporal `exp(−Δt/τ)` when `temporalDecayTau` is set).

**Lateral inhibition with winner-take-all sparsity** (their Eq. 3, applied per hop):

```
û_i(t+1) = max(0, u_i(t+1) − β · Σ_{k ∈ T_M, u_k > u_i} (u_k − u_i))
```

with `β = 0.15` and `M = 7` competing top nodes. Suppression is **non-symmetric** (only flows from higher-activation to lower) and applied *before* the sigmoid nonlinearity each hop, not once at the end. This is the mechanism that delivered the adversarial-robustness lift (96.6→71.5 F1 ablation when removed) and is the primitive most directly applicable to our tier-2 vocabulary-distractor failure (`pw_pausanias_commands` on "generals").

## What we explicitly are NOT copying

- **Triple Hybrid Retrieval** (their Eq. 5, `S(v_i) = λ₁·sim + λ₂·activation + λ₃·PageRank`). We stop at activation-as-reranker over the anchor set — Dijkstra path traversal stays the retrieval substrate. Adopting their final fusion would replace our entire path-scoring pipeline.
- **PageRank** as a third score channel. Out of scope; we have no global node-importance signal cached.
- **Sigmoid nonlinearity** on activation each hop (their Eq. 4). Optional later refinement; not needed for the ranking-only use case since order is preserved.
- **τ-gate confidence rejection** (their `τ_gate = 0.12`). Our retriever returns a top-N regardless; abstention is a downstream concern.
- **Per-N-turn PageRank consolidation**. We are stateless across `retrieve()` calls (Phase-3 access tracking is observability-only).

## Implementation-critical defaults & failure modes

| Param | Paper default | Our mapping |
|---|---|---|
| S (spread) | 0.8 | `decay` complement; map directly |
| δ (decay/retention) | 0.5 | `decay` config knob (we'll use `decay = 1 − δ` semantics OR keep paper's; decide in plan) |
| T (hops) | 3 | `maxHops` |
| β (inhibition) | 0.15 | `inhibitionStrength` |
| M (sparsity) | 7 | `lateralInhibitionTopM` (replaces plan's `lateralInhibitionTau` cosine-pair version — see below) |
| seed top-K | (BM25+dense) | `initialTopK` (plan-default 5) |
| ρ (temporal) | 0.01 | already present as `temporalDecayTau` |

**Key deviation to flag in implementation plan:** the plan-as-written (PLAN-post-2.8.md §Phase 2.10) describes a *cosine-pair* lateral inhibition (`lateralInhibitionTau` thresholds embedding similarity between two anchors). The paper's mechanism is *activation-rank* lateral inhibition (top-M nodes by current activation suppress the rest, no embedding comparison). The paper's version is cheaper (no extra cosines) and ablation-validated. Recommend swapping the plan's design for the paper's during the implementation-plan step.

**Bounds against runaway activation** (per paper §3.2): the combination of (i) sigmoid clamp, (ii) lateral inhibition zeroing low-activation nodes, and (iii) top-M sparsity is what keeps the activation set bounded. Without lateral inhibition the activation set blows up across hops; without `fan(j)` dilution hub nodes dominate. We need at least the latter two even without sigmoid.

**Convergence**: paper reports `T = 3` iterations sufficient — Table 6 shows minimal F1 movement past 3. Don't sweep `maxHops > 3` in primary sweep.

## Ablation evidence guiding our success bar

| Ablation | F1 drop | Implication for us |
|---|---|---|
| No temporal decay | 50.1 → 14.2 (temporal split) | Confirms temporal-edge weighting matters. We already have it; keep on. |
| No fan effect | 25.9 → 16.8 (open-domain) | Must include fan-out dilution in propagation, not just raw edge weight. |
| No lateral inhibition | 96.6 → 71.5 (adversarial) | The vocabulary-distractor scenario in our tier-2 IS analogous to adversarial here. Lateral inhibition is the load-bearing component for our pass criterion. |
| Vectors only | 25.2 vs full 40.5 | Confirms graph-traversal + activation reranking beats cosine alone — the foundational claim Phase 2.10 is testing on our corpus. |

## Open implementation questions for plan stage

1. **Inhibition variant** — adopt paper's top-M-by-activation (recommended) or keep PLAN's cosine-pair version? Default to paper's; cosine-pair is a fallback if the corpus is too small for top-M to differentiate.
2. **Edge-type-aware propagation** — apply `temporalHopCost`-style damping during propagation, or rely solely on edge.weight? Paper uses edge weight only; suggest matching for parity.
3. **Per-probe vs. global activation field** — paper has a single query, single activation pass. We have multiple probes. Two options: (a) run propagation once seeded from union of per-probe anchors with summed initial activation; (b) per-probe propagation, fuse activation vectors. Default (a) for cost; document as a sweep dimension if (a) underperforms.
4. **Reuse of `GraphIndex.neighbors()`** — already exposes type filter; no signature change needed unless we want a weight-aware variant. Likely fine as-is for the propagation pass.
