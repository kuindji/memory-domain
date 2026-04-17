import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { tier1Alex } from "../data/tier1-alex.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { tier3Wikipedia } from "../data/tier3-wikipedia.js";
import { tracesTier1 } from "./conversation-traces-tier1.js";
import { tracesTier2 } from "./conversation-traces-tier2.js";
import { tracesTier3 } from "./conversation-traces-tier3.js";
import type { ClaimId, RetrievalOptions, ScoredPath } from "../src/types.js";

const TIER = (process.env.TIER ?? "tier1").toLowerCase();
const DATASET =
    TIER === "tier3"
        ? { claims: tier3Wikipedia, traces: tracesTier3 }
        : TIER === "tier2"
          ? { claims: tier2Greek, traces: tracesTier2 }
          : { claims: tier1Alex, traces: tracesTier1 };

const CLAIM_TEXT_BY_ID = new Map<string, string>(DATASET.claims.map((c) => [c.id, c.text]));

// Substring match against trace.name (lowercased). Lets e.g. `ARC=alexander`
// pick the single "Alexander succession arc" without memorising the full string.
const ARC_NAME_FILTER = (process.env.ARC ?? "").toLowerCase();

function rankClaims(paths: ScoredPath[]): ClaimId[] {
    const best = new Map<ClaimId, number>();
    for (const p of paths) {
        for (const id of p.path.nodeIds) {
            const cur = best.get(id);
            if (cur === undefined || p.score > cur) best.set(id, p.score);
        }
    }
    return Array.from(best.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
}

type Config = {
    label: string;
    temporalDecayTau?: number;
    options: RetrievalOptions;
};

// Phase 2.3 sweep — Option J (non-linear probe-coverage anchor scoring).
// Compares Phase-2.1/2.2 baselines against two J variants:
//   • density-coverage-bonus: `Σ w(p)·max(0, cos − τ) · k^(exp − 1)` —
//     super-linear reward on probe-coverage count.
//   • min-cosine-gate: hard k=P gate, score = min weighted per-probe
//     contribution (strict-AND analogue of intersection).
// Isolation rows sweep the exponent, decay on/off, session-weight toggle,
// and Dijkstra pairing so any lift can be attributed to the coverage-
// bonus signal vs. Phase-2.1 decay or Phase-1.5 traversal.
const CONFIGS: Config[] = [
    {
        // Legacy pre-Phase-2.1 default — explicit union so the comparison
        // against the new default isn't masked by the silent default flip.
        label: "bfs union (legacy default)",
        options: { traversal: "bfs", probeComposition: "union" },
    },
    {
        label: "bfs wfusion tau=0.2 (Phase 2.1 default)",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
        },
    },
    {
        label: "bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "J cov-bonus exp=2 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.2, exponent: 2 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "J cov-bonus exp=2 tau=0.3 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.3, exponent: 2 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "J cov-bonus exp=1.5 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.2, exponent: 1.5 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "J cov-bonus exp=3 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.2, exponent: 3 },
            sessionDecayTau: 0.3,
        },
    },
    {
        // Decay-isolation row: any lift here is attributable to the
        // coverage-bonus signal, not Phase-2.1 decay. At exp=1 this
        // reduces to Option I (same formula) — makes the per-exponent
        // comparison legible.
        label: "J cov-bonus exp=2 tau=0.2 no decay",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.2, exponent: 2 },
        },
    },
    {
        // Session-weight isolation: decay is on but the anchor-scorer
        // ignores it. If this row matches the no-decay row, decay is
        // inert inside J; if it matches the with-decay row, it stayed
        // active via probeCoverage weighting only.
        label: "J cov-bonus exp=2 tau=0.2 useSessionWeights=false + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: {
                kind: "density-coverage-bonus",
                tau: 0.2,
                exponent: 2,
                useSessionWeights: false,
            },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "J min-gate tau=0.1 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "min-cosine-gate", tau: 0.1 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "J min-gate tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "min-cosine-gate", tau: 0.2 },
            sessionDecayTau: 0.3,
        },
    },
    {
        // Phase 1.6 predicted Dijkstra needs higher-quality anchors to
        // lift F1 — J's coverage-bonus is the strongest candidate so far.
        label: "J cov-bonus exp=2 tau=0.2 + decay=0.3 on dijkstra",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.2, exponent: 2 },
            sessionDecayTau: 0.3,
        },
    },

    // --- Phase 2.4 sweep: Option H (cluster-affinity-boost) -------------
    // Base aggregate matches Option I at τ=0.2; boost adds
    // (1 + β·max_p clusterAffinity(p, c)) multiplicatively. k brackets the
    // known 8-cluster ground truth (pan_/pol_/pw_/pwar_/phil_/alex_/diad_/art_)
    // on tier-2. Paired with decay=0.3 so the comparison is apples-to-apples
    // with the Phase-2.1-best row.
    {
        label: "H k=4 β=1.0 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 1.0, k: 4 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "H k=6 β=0.5 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 0.5, k: 6 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "H k=6 β=1.0 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 1.0, k: 6 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "H k=6 β=2.0 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 2.0, k: 6 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "H k=8 β=0.5 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 0.5, k: 8 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "H k=8 β=1.0 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 1.0, k: 8 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "H k=8 β=2.0 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 2.0, k: 8 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "H k=10 β=1.0 tau=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 1.0, k: 10 },
            sessionDecayTau: 0.3,
        },
    },
    {
        // Isolation row: β=0 at the winning k must match Option I exactly —
        // any divergence between the β=0 row and the "Phase 2.1 best"
        // aggregate indicates a bug in the H branch's base aggregation.
        label: "H k=8 β=0 tau=0.2 + decay=0.3 (isolation)",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 0, k: 8 },
            sessionDecayTau: 0.3,
        },
    },

    // --- Phase 2.5 sweep: Option L (expand anchor candidate set) ----------
    // Per-turn diagnostic after Phase 2.4 showed `phil_plato_forms` is never
    // in the Academy-arc turn-3 anchor top-5 at any config. Option L widens
    // `anchorTopK` so the candidate simply has a chance to surface. Pair
    // with the Phase-2.1-best scorer so the only moving variable is the
    // candidate-set size. Cross-rows at H-best and J-best check whether
    // the extra candidates interact with cluster boost / coverage bonus.
    {
        label: "L wfusion tau=0.2 + decay=0.3 anchorTopK=10",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            sessionDecayTau: 0.3,
            anchorTopK: 10,
        },
    },
    {
        label: "L wfusion tau=0.2 + decay=0.3 anchorTopK=15",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            sessionDecayTau: 0.3,
            anchorTopK: 15,
        },
    },
    {
        // Stretch row — only informative if 10/15 leave the floor unchanged.
        label: "L wfusion tau=0.2 + decay=0.3 anchorTopK=20",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            sessionDecayTau: 0.3,
            anchorTopK: 20,
        },
    },
    {
        // Cross with best-so-far H config — does widening interact with
        // cluster-affinity boost?
        label: "L×H k=6 β=1.0 tau=0.2 + decay=0.3 anchorTopK=10",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 1.0, k: 6 },
            sessionDecayTau: 0.3,
            anchorTopK: 10,
        },
    },
    {
        label: "L×H k=6 β=1.0 tau=0.2 + decay=0.3 anchorTopK=15",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta: 1.0, k: 6 },
            sessionDecayTau: 0.3,
            anchorTopK: 15,
        },
    },
    {
        // Cross with J coverage-bonus — same question, different aggregate.
        label: "L×J cov-bonus exp=2 tau=0.2 + decay=0.3 anchorTopK=10",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.2, exponent: 2 },
            sessionDecayTau: 0.3,
            anchorTopK: 10,
        },
    },

    // --- Phase 2.6 sweep: Option M (idf-weighted-fusion anchor scoring) ---
    // Per-turn diagnostic after Phase 2.4 identified tier-2 failure mode #1
    // as a vocabulary distractor: generic-token claims (e.g. `pw_pausanias_
    // commands` matching the probe word "generals") outrank specific
    // claims. A2 `cosine-idf-mass` already exists but runs only in the per-
    // probe top-K path, which is bypassed by weighted-fusion composition.
    // Option M ports the IDF-mass multiplier into the aggregate itself:
    //   score(c) = (1 + α · normIdf(c)) · Σ_p w(p) · max(0, cos(p,c) - τ)
    // α=0 isolation row must match Phase-2.1-best exactly. Sweep α over
    // {0.3, 0.5, 0.7, 1.0}; τ=0.2 + decay=0.3 matches Phase-2.1-best.
    {
        label: "M idf-fusion τ=0.2 α=0 + decay=0.3 (isolation)",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M idf-fusion τ=0.2 α=0.3 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.3 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M idf-fusion τ=0.2 α=0.5 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.5 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M idf-fusion τ=0.2 α=0.7 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.7 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M idf-fusion τ=0.2 α=1.0 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 1.0 },
            sessionDecayTau: 0.3,
        },
    },
    {
        // Stretch — if α up to 1.0 under-moves the ranking, check whether
        // a stronger multiplier helps. Also documents the monotonicity
        // direction (if perf degrades past some α, that's the best-α
        // signal).
        label: "M idf-fusion τ=0.2 α=2.0 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 2.0 },
            sessionDecayTau: 0.3,
        },
    },
    {
        // No-decay isolation: any lift here is attributable to IDF mass,
        // not Phase-2.1 session decay. Paired with α=0.5 as a mid-sweep
        // point.
        label: "M idf-fusion τ=0.2 α=0.5 no decay",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.5 },
        },
    },
    {
        // Session-weight isolation toggle — parallels the J / I pattern.
        label: "M idf-fusion τ=0.2 α=0.5 useSessionWeights=false + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: {
                kind: "idf-weighted-fusion",
                tau: 0.2,
                alpha: 0.5,
                useSessionWeights: false,
            },
            sessionDecayTau: 0.3,
        },
    },
    // --- Phase 2.10 Option O (spreading-activation) — eval-B target -------
    // SYNAPSE-inspired spreading activation + lateral inhibition. Pass
    // criterion: tier-2 coherence ≥ 2/4 (Phase 2.1 best-ever was 1/4 under
    // BGE-small). Phase 2.8 baseline traversal (dijkstra tmp=0.5) so the
    // coherence movement is attributable to the new anchor scorer. Same
    // 16 primary + 5 ablation rows as eval-A sweep — kept in lockstep so
    // the gate and target are read against identical config space.
    ...((): Config[] => {
        const rows: Config[] = [];
        const base = {
            spreadingFactor: 0.8,
            inhibitionStrength: 0.15,
            useSessionWeights: true,
        };
        for (const initialTopK of [5, 8]) {
            for (const maxHops of [2, 3]) {
                for (const decay of [0.5, 0.7]) {
                    for (const inhibitionTopM of [5, 7]) {
                        rows.push({
                            label: `O dijkstra tmp=0.5 sa K0=${initialTopK} T=${maxHops} δ=${decay} M=${inhibitionTopM}`,
                            options: {
                                traversal: "dijkstra",
                                temporalHopCost: 0.5,
                                anchorScoring: {
                                    kind: "spreading-activation",
                                    initialTopK,
                                    maxHops,
                                    decay,
                                    inhibitionTopM,
                                    ...base,
                                },
                            },
                        });
                    }
                }
            }
        }
        const central = { initialTopK: 5, maxHops: 3, decay: 0.5, inhibitionTopM: 7 };
        rows.push({
            label: "O dijkstra tmp=0.5 sa central β=0 (no-inhibition isolation)",
            options: {
                traversal: "dijkstra",
                temporalHopCost: 0.5,
                anchorScoring: {
                    kind: "spreading-activation",
                    ...central,
                    spreadingFactor: 0.8,
                    inhibitionStrength: 0,
                    useSessionWeights: true,
                },
            },
        });
        for (const inhibitionStrength of [0.1, 0.25]) {
            rows.push({
                label: `O dijkstra tmp=0.5 sa central β=${inhibitionStrength}`,
                options: {
                    traversal: "dijkstra",
                    temporalHopCost: 0.5,
                    anchorScoring: {
                        kind: "spreading-activation",
                        ...central,
                        spreadingFactor: 0.8,
                        inhibitionStrength,
                        useSessionWeights: true,
                    },
                },
            });
        }
        for (const spreadingFactor of [0.6, 1.0]) {
            rows.push({
                label: `O dijkstra tmp=0.5 sa central S=${spreadingFactor}`,
                options: {
                    traversal: "dijkstra",
                    temporalHopCost: 0.5,
                    anchorScoring: {
                        kind: "spreading-activation",
                        ...central,
                        spreadingFactor,
                        inhibitionStrength: 0.15,
                        useSessionWeights: true,
                    },
                },
            });
        }
        return rows;
    })(),

    // ---- Phase 4a: edge-hotness soft-penalty gate on Dijkstra --------------
    // Motivation (see `path_memory_phase29`): repeat-user traces produce a
    // 7.7× edge-concentration signal. Eval-B's multi-turn arcs give the gate
    // a real chance to build a rolling hot set within a single session.
    //
    // Rows pin to Phase-2.8 default traversal (`dijkstra` +
    // `temporalHopCost: 0.5`) and enable `accessTracking` so the gate activates.
    ...(() => {
        const rows: Config[] = [];
        for (const topK of [50, 100, 200]) {
            for (const penalty of [1.5, 2.0]) {
                rows.push({
                    label: `4a dijkstra tmp=0.5 hotK=${topK} penalty=${penalty}`,
                    options: {
                        traversal: "dijkstra",
                        temporalHopCost: 0.5,
                        accessTracking: true,
                        hotEdgeTopK: topK,
                        hotEdgeColdPenalty: penalty,
                    },
                });
            }
        }
        return rows;
    })(),
    // Phase 2.14 — retune anchor primitives under bge-base (new default).
    // Phase 2.13 landed bge-base at 2/4 eval-B coherence (bfs wfusion τ=0.2 +
    // decay=0.3). Failing arcs: "Athens at war" (cov 0.33) and "Alexander
    // succession" (cov 0.33). Stage 1: 1D knob sweeps to push 2/4 → 3/4.
    // Control row lives at label "bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)".
    ...(() => {
        const rows: Config[] = [];
        // sessionDecayTau sweep on bfs wfusion τ=0.2 (0.3 is current best; untested neighbours).
        for (const decay of [0.1, 0.2, 0.4, 0.5]) {
            rows.push({
                label: `2.14 bfs wfusion τ=0.2 + decay=${decay}`,
                options: {
                    traversal: "bfs",
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: 0.2,
                    sessionDecayTau: decay,
                },
            });
        }
        // weightedFusionTau sweep at decay=0.3 (gate may want to move under bge-base).
        for (const tau of [0.1, 0.15, 0.3]) {
            rows.push({
                label: `2.14 bfs wfusion τ=${tau} + decay=0.3`,
                options: {
                    traversal: "bfs",
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: tau,
                    sessionDecayTau: 0.3,
                },
            });
        }
        // anchorTopK sweep on current best (K=5 is default; K≥10 ruled out as Option L).
        for (const topK of [3, 7]) {
            rows.push({
                label: `2.14 bfs wfusion τ=0.2 + decay=0.3 + K=${topK}`,
                options: {
                    traversal: "bfs",
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: 0.2,
                    sessionDecayTau: 0.3,
                    anchorTopK: topK,
                },
            });
        }
        return rows;
    })(),

    // Phase 2.14 Stage 2 — targeted retest of Option H (cluster-affinity-boost)
    // and Option A1 (temporalDecayTau) under bge-base on the remaining failing
    // arc (Alexander succession, cov=0.33). Both were pruned under MiniLM; the
    // bge-base geometry is different enough to warrant a narrow retest before
    // declaring the arc encoder-granularity-bound. Control row reuses the
    // Phase 2.14 default at label "2.14 bfs wfusion τ=0.2 + decay=0.2".
    ...(() => {
        const rows: Config[] = [];
        const hGrid: { k: number; beta: number }[] = [
            { k: 4, beta: 0.5 },
            { k: 4, beta: 1.0 },
            { k: 6, beta: 0.5 },
            { k: 6, beta: 1.0 },
            { k: 8, beta: 0.5 },
        ];
        for (const { k, beta } of hGrid) {
            rows.push({
                label: `2.14s2 H k=${k} β=${beta} tau=0.2 + decay=0.2`,
                options: {
                    traversal: "bfs",
                    anchorScoring: { kind: "cluster-affinity-boost", tau: 0.2, beta, k },
                    sessionDecayTau: 0.2,
                },
            });
        }
        for (const temporalDecayTau of [2, 5, 10]) {
            rows.push({
                label: `2.14s2 A1 temporalDecayTau=${temporalDecayTau} + wfusion τ=0.2 + decay=0.2`,
                temporalDecayTau,
                options: {
                    traversal: "bfs",
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: 0.2,
                    sessionDecayTau: 0.2,
                },
            });
        }
        return rows;
    })(),

    // Phase 2.15 — retune anchor primitives under bge-large (opt-in encoder).
    // Phase 2.13 established bge-large at 2/4 eval-B coherence with
    // "bfs wfusion τ=0.2 + decay=0.3"; Stage-0 PER_ARC diagnostic confirmed
    // failing arcs = Athens + Alexander (same shape as bge-base pre-2.14) but
    // with a DIFFERENT missing/unexpected claim signature than the Phase-2.14
    // Stage-2 frozen signature under bge-base — suggesting arc failure is
    // encoder-geometry-sensitive. Stage-1 sweep mirrors Phase 2.14's 1D grid
    // (decay / weightedFusionTau / anchorTopK) plus a Dijkstra-tmp sanity
    // band to confirm Phase 2.13's "BFS dominates under bge-large" finding
    // across tmp ∈ {0.3, 0.5, 0.7}. Control row reuses Phase-2.13 label
    // "bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)".
    ...(() => {
        const rows: Config[] = [];
        // Decay sweep on bfs wfusion τ=0.2 — primary 1D retune.
        for (const decay of [0.1, 0.2, 0.4, 0.5]) {
            rows.push({
                label: `2.15 bfs wfusion τ=0.2 + decay=${decay}`,
                options: {
                    traversal: "bfs",
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: 0.2,
                    sessionDecayTau: decay,
                },
            });
        }
        // weightedFusionTau sweep at decay=0.3.
        for (const tau of [0.1, 0.15, 0.3]) {
            rows.push({
                label: `2.15 bfs wfusion τ=${tau} + decay=0.3`,
                options: {
                    traversal: "bfs",
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: tau,
                    sessionDecayTau: 0.3,
                },
            });
        }
        // anchorTopK sweep on current best.
        for (const topK of [3, 7]) {
            rows.push({
                label: `2.15 bfs wfusion τ=0.2 + decay=0.3 + K=${topK}`,
                options: {
                    traversal: "bfs",
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: 0.2,
                    sessionDecayTau: 0.3,
                    anchorTopK: topK,
                },
            });
        }
        // Dijkstra-tmp sanity — Phase 2.13 tested only tmp=0.5 under
        // bge-large and found BFS wins. Widen the band.
        for (const tmp of [0.3, 0.5, 0.7]) {
            rows.push({
                label: `2.15 dijkstra tmp=${tmp} wfusion τ=0.2 + decay=0.3`,
                options: {
                    traversal: "dijkstra",
                    temporalHopCost: tmp,
                    probeComposition: "weighted-fusion",
                    weightedFusionTau: 0.2,
                    sessionDecayTau: 0.3,
                },
            });
        }
        return rows;
    })(),
];

// Tier-3 validation matrix (Phase 2.7). Narrow sweep per CONTEXT.md §1828 —
// this validates Option M at scale rather than re-sweeping the Phase-2
// design space. Baseline rows + M at α ∈ {0.3, 0.5, 0.7, 1.0}, all paired
// with `sessionDecayTau=0.3` (Phase 2.1 best).
const CONFIGS_TIER3: Config[] = [
    { label: "baseline bfs", options: { traversal: "bfs" } },
    {
        label: "baseline-2.1 bfs wfusion τ=0.2 + decay=0.3",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=0.3 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.3 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=0.5 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.5 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=0.7 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.7 },
            sessionDecayTau: 0.3,
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=1.0 + decay=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 1.0 },
            sessionDecayTau: 0.3,
        },
    },
];

// Phase-2.13 narrow matrix for eval-B: Phase-2.1 defaults + J min-gate.
// Pruned primitives (L, M α≥0.5, A1, H, J density) excluded per
// path_memory_phase28 memory.
const PHASE_213_LABELS = new Set<string>([
    "bfs wfusion tau=0.2 (Phase 2.1 default)",
    "bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)",
    "J min-gate tau=0.1 + decay=0.3",
    "J min-gate tau=0.2 + decay=0.3",
]);

// Phase-2.14 narrow matrix: control + Stage-1 1D sweeps on decay / wfusion τ
// / anchorTopK under bge-base. See CONFIGS entries labelled "2.14 ...".
const PHASE_214_LABELS = new Set<string>([
    "bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)",
    "2.14 bfs wfusion τ=0.2 + decay=0.1",
    "2.14 bfs wfusion τ=0.2 + decay=0.2",
    "2.14 bfs wfusion τ=0.2 + decay=0.4",
    "2.14 bfs wfusion τ=0.2 + decay=0.5",
    "2.14 bfs wfusion τ=0.1 + decay=0.3",
    "2.14 bfs wfusion τ=0.15 + decay=0.3",
    "2.14 bfs wfusion τ=0.3 + decay=0.3",
    "2.14 bfs wfusion τ=0.2 + decay=0.3 + K=3",
    "2.14 bfs wfusion τ=0.2 + decay=0.3 + K=7",
]);

// Phase-2.14 Stage 2 narrow matrix: new Phase-2.14 default as control + H/A1
// retest on the Alexander-succession arc. See CONFIGS entries labelled
// "2.14s2 ...".
const PHASE_214_STAGE2_LABELS = new Set<string>([
    "2.14 bfs wfusion τ=0.2 + decay=0.2",
    "2.14s2 H k=4 β=0.5 tau=0.2 + decay=0.2",
    "2.14s2 H k=4 β=1 tau=0.2 + decay=0.2",
    "2.14s2 H k=6 β=0.5 tau=0.2 + decay=0.2",
    "2.14s2 H k=6 β=1 tau=0.2 + decay=0.2",
    "2.14s2 H k=8 β=0.5 tau=0.2 + decay=0.2",
    "2.14s2 A1 temporalDecayTau=2 + wfusion τ=0.2 + decay=0.2",
    "2.14s2 A1 temporalDecayTau=5 + wfusion τ=0.2 + decay=0.2",
    "2.14s2 A1 temporalDecayTau=10 + wfusion τ=0.2 + decay=0.2",
]);

// Phase-2.15 narrow matrix: Phase-2.13 bge-large control + Stage-1 1D
// sweeps (decay / wfusion τ / anchorTopK / dijkstra-tmp) under bge-large.
// See CONFIGS entries labelled "2.15 ...".
const PHASE_215_LABELS = new Set<string>([
    "bfs wfusion tau=0.2 + decay=0.3 (Phase 2.1 best)",
    "2.15 bfs wfusion τ=0.2 + decay=0.1",
    "2.15 bfs wfusion τ=0.2 + decay=0.2",
    "2.15 bfs wfusion τ=0.2 + decay=0.4",
    "2.15 bfs wfusion τ=0.2 + decay=0.5",
    "2.15 bfs wfusion τ=0.1 + decay=0.3",
    "2.15 bfs wfusion τ=0.15 + decay=0.3",
    "2.15 bfs wfusion τ=0.3 + decay=0.3",
    "2.15 bfs wfusion τ=0.2 + decay=0.3 + K=3",
    "2.15 bfs wfusion τ=0.2 + decay=0.3 + K=7",
    "2.15 dijkstra tmp=0.3 wfusion τ=0.2 + decay=0.3",
    "2.15 dijkstra tmp=0.5 wfusion τ=0.2 + decay=0.3",
    "2.15 dijkstra tmp=0.7 wfusion τ=0.2 + decay=0.3",
]);

const CONFIG_SET = (process.env.CONFIG_SET ?? "").toLowerCase();

const ACTIVE_CONFIGS =
    CONFIG_SET === "phase213"
        ? CONFIGS.filter((c) => PHASE_213_LABELS.has(c.label))
        : CONFIG_SET === "phase214"
          ? CONFIGS.filter((c) => PHASE_214_LABELS.has(c.label))
          : CONFIG_SET === "phase214-stage2"
            ? CONFIGS.filter((c) => PHASE_214_STAGE2_LABELS.has(c.label))
            : CONFIG_SET === "phase215"
              ? CONFIGS.filter((c) => PHASE_215_LABELS.has(c.label))
              : TIER === "tier3"
                ? CONFIGS_TIER3
                : CONFIGS;

type ConfigResult = {
    narrowed: number;
    coherent: number;
    arcs: number;
    nodeBumps: number;
    edgeBumps: number;
    distinctNodes: number;
    distinctEdges: number;
    nodeTop5Share: number;
    edgeTop5Share: number;
};

async function runConfig(config: Config): Promise<ConfigResult> {
    const embedder = await getEmbedder();
    const memory = new PathMemory({
        embedder,
        temporalDecayTau: config.temporalDecayTau,
    });
    for (const c of DATASET.claims) {
        await memory.ingest({
            id: c.id,
            text: c.text,
            validFrom: c.validFrom,
            supersedes: c.supersedes,
        });
    }

    let narrowed = 0;
    let coherent = 0;
    let arcs = 0;
    const perArc: {
        name: string;
        narrowed: boolean;
        coherent: boolean;
        coverage: number;
        missing: ClaimId[];
        unexpected: ClaimId[];
    }[] = [];

    for (const trace of DATASET.traces) {
        if (ARC_NAME_FILTER && !trace.name.toLowerCase().includes(ARC_NAME_FILTER)) continue;
        const session = memory.createSession();
        const sizeAcrossTurns: number[] = [];
        let lastTopClaims: Set<ClaimId> = new Set();

        for (const turn of trace.turns) {
            await session.addProbeSentences(turn.probes);
            const results = session.retrieve({
                mode: trace.mode,
                anchorTopK: 5,
                resultTopN: 10,
                accessTracking: true,
                ...config.options,
            });
            const ranked = rankClaims(results);
            const expected = new Set(turn.expectedClaimsAfterThisTurn);
            const topK = Math.max(expected.size, 3);
            lastTopClaims = new Set(ranked.slice(0, topK));
            sizeAcrossTurns.push(results.length);
        }

        const first = sizeAcrossTurns[0];
        const last = sizeAcrossTurns[sizeAcrossTurns.length - 1];
        const arcNarrowed = last <= first;
        if (arcNarrowed) narrowed++;

        const finalExpected = new Set(
            trace.turns[trace.turns.length - 1].expectedClaimsAfterThisTurn,
        );
        const coverage =
            finalExpected.size > 0
                ? intersectionSize(finalExpected, lastTopClaims) / finalExpected.size
                : 0;
        const arcCoherent = coverage >= 0.5;
        if (arcCoherent) coherent++;
        arcs++;
        const missing: ClaimId[] = [];
        for (const id of finalExpected) if (!lastTopClaims.has(id)) missing.push(id);
        const unexpected: ClaimId[] = [];
        for (const id of lastTopClaims) if (!finalExpected.has(id)) unexpected.push(id);
        perArc.push({
            name: trace.name,
            narrowed: arcNarrowed,
            coherent: arcCoherent,
            coverage,
            missing,
            unexpected,
        });
    }

    if (process.env.PER_ARC === "1") {
        for (const a of perArc) {
            console.log(
                `    · ${a.name.padEnd(48)} narrow=${a.narrowed ? "Y" : "n"} coh=${a.coherent ? "Y" : "n"} cov=${a.coverage.toFixed(2)}`,
            );
            if (a.missing.length > 0) {
                console.log(`      missing (${a.missing.length}):`);
                for (const id of a.missing) {
                    console.log(`        - ${id}: ${CLAIM_TEXT_BY_ID.get(id) ?? "(unknown)"}`);
                }
            }
            if (a.unexpected.length > 0) {
                console.log(`      unexpected in top-K (${a.unexpected.length}):`);
                for (const id of a.unexpected) {
                    console.log(`        - ${id}: ${CLAIM_TEXT_BY_ID.get(id) ?? "(unknown)"}`);
                }
            }
        }
    }

    const snap = memory.graph.accessStatsSnapshot();
    const topNodeCount = snap.nodes.slice(0, 5).reduce((s, n) => s + n.count, 0);
    const topEdgeCount = snap.edges.slice(0, 5).reduce((s, e) => s + e.count, 0);
    return {
        narrowed,
        coherent,
        arcs,
        nodeBumps: snap.totals.nodeBumps,
        edgeBumps: snap.totals.edgeBumps,
        distinctNodes: snap.totals.distinctNodes,
        distinctEdges: snap.totals.distinctEdges,
        nodeTop5Share: snap.totals.nodeBumps > 0 ? topNodeCount / snap.totals.nodeBumps : 0,
        edgeTop5Share: snap.totals.edgeBumps > 0 ? topEdgeCount / snap.totals.edgeBumps : 0,
    };
}

async function main(): Promise<void> {
    console.log(
        `# iterative-sweep tier=${TIER}  (claims=${DATASET.claims.length}, traces=${DATASET.traces.length})`,
    );
    console.log(
        `config | narrowed | coherent | nodeBumps(distinct) | top5-share | edgeBumps(distinct) | top5-share`,
    );
    for (const cfg of ACTIVE_CONFIGS) {
        const r = await runConfig(cfg);
        console.log(
            [
                cfg.label.padEnd(48),
                `${r.narrowed}/${r.arcs}`,
                `${r.coherent}/${r.arcs}`,
                `${r.nodeBumps}(${r.distinctNodes})`,
                r.nodeTop5Share.toFixed(3),
                `${r.edgeBumps}(${r.distinctEdges})`,
                r.edgeTop5Share.toFixed(3),
            ].join(" | "),
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
