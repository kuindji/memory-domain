import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { FlatVectorBaseline } from "./baseline.js";
import { tier1Alex } from "../data/tier1-alex.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { tier3Wikipedia } from "../data/tier3-wikipedia.js";
import { queriesTier1 } from "./queries-tier1.js";
import { queriesTier2 } from "./queries-tier2.js";
import { queriesTier3 } from "./queries-tier3.js";
import type { ClaimId, ScoredPath, RetrievalOptions } from "../src/types.js";

// Select tier via TIER env var. Default is tier1 for back-compat with
// pre-Phase-2 invocations; TIER=tier2 selects the Greek-history corpus;
// TIER=tier3 selects the Wikipedia corpus (see scripts/tier3-*.ts).
const TIER = (process.env.TIER ?? "tier1").toLowerCase();
const DATASET =
    TIER === "tier3"
        ? { claims: tier3Wikipedia, queries: queriesTier3 }
        : TIER === "tier2"
          ? { claims: tier2Greek, queries: queriesTier2 }
          : { claims: tier1Alex, queries: queriesTier1 };

function f1(ideal: Set<ClaimId>, predicted: ClaimId[]): number {
    if (predicted.length === 0 || ideal.size === 0) return 0;
    let hits = 0;
    for (const id of predicted) if (ideal.has(id)) hits++;
    const precision = hits / predicted.length;
    const recall = hits / ideal.size;
    return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

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

type Config = {
    label: string;
    lexicalIdfFloor?: number;
    temporalDecayTau?: number;
    options: RetrievalOptions;
};

const CONFIGS: Config[] = [
    // --- BFS baseline (Phase 1 default) for reference ---
    { label: "bfs (default)", options: { traversal: "bfs" } },
    // --- Phase 1.5 Dijkstra reference (best plateau) ---
    {
        label: "dijkstra tmp=0.5",
        options: { traversal: "dijkstra", temporalHopCost: 0.5 },
    },
    // --- Phase 1.6 A1: temporal decay tau sweep ---
    {
        label: "A1 dijkstra tau=2 tmp=0.5",
        temporalDecayTau: 2,
        options: { traversal: "dijkstra", temporalHopCost: 0.5 },
    },
    {
        label: "A1 dijkstra tau=5 tmp=0.5",
        temporalDecayTau: 5,
        options: { traversal: "dijkstra", temporalHopCost: 0.5 },
    },
    {
        label: "A1 dijkstra tau=10 tmp=0.5",
        temporalDecayTau: 10,
        options: { traversal: "dijkstra", temporalHopCost: 0.5 },
    },
    // --- Phase 1.6 A2: cosine + IDF-mass anchor scoring ---
    {
        label: "A2 bfs anchor=idf alpha=0.5",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.5 },
        },
    },
    {
        label: "A2 bfs anchor=idf alpha=1.0",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cosine-idf-mass", alpha: 1.0 },
        },
    },
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=0.5",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.5 },
        },
    },
    // --- Phase 1.6 A3: probe composition ---
    {
        label: "A3 bfs probe=intersection",
        options: { traversal: "bfs", probeComposition: "intersection" },
    },
    {
        label: "A3 bfs probe=weighted-fusion tau=0.2",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
        },
    },
    {
        label: "A3 bfs probe=weighted-fusion tau=0.3",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.3,
        },
    },
    {
        label: "A3 dijkstra tmp=0.5 probe=intersection",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            probeComposition: "intersection",
        },
    },
    {
        label: "A3 dijkstra tmp=0.5 probe=weighted-fusion tau=0.2",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
        },
    },
    // --- Phase 1.6 A2 finer alpha sweep around 0.5 (best so far) ---
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=0.3",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.3 },
        },
    },
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=0.7",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.7 },
        },
    },
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=0.6",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.6 },
        },
    },
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=0.8",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.8 },
        },
    },
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=0.9",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.9 },
        },
    },
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=1.0",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 1.0 },
        },
    },
    // BFS variant of α=0.7 to isolate Dijkstra vs anchor contributions
    {
        label: "A2 bfs anchor=idf alpha=0.7",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.7 },
        },
    },
    // --- A2+A3 combos (no A1) ---
    {
        label: "A2+A3 dijkstra anchor=idf a=0.5 probe=intersection",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.5 },
            probeComposition: "intersection",
        },
    },
    {
        label: "A2+A3 dijkstra anchor=idf a=0.7 probe=intersection",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.7 },
            probeComposition: "intersection",
        },
    },
    {
        label: "A2+A3 dijkstra anchor=idf a=0.5 fusion tau=0.2",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.5 },
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
        },
    },
    // --- Combined best-of (filled in after individual sweeps) ---
    {
        label: "A1+A2 dijkstra tau=5 anchor=idf alpha=0.5",
        temporalDecayTau: 5,
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.5 },
        },
    },
    {
        label: "A1+A3 dijkstra tau=5 probe=weighted-fusion tau=0.2",
        temporalDecayTau: 5,
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
        },
    },
    {
        label: "A1+A2+A3 dijkstra tau=5 anchor=idf a=0.5 fusion tau=0.2",
        temporalDecayTau: 5,
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.5 },
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
        },
    },
    // --- Phase 2.2 Option I (weighted-probe-density anchor scoring) ---
    {
        label: "I bfs tau=0.2",
        options: {
            traversal: "bfs",
            probeComposition: "union",
            anchorScoring: { kind: "weighted-probe-density", tau: 0.2 },
        },
    },
    {
        label: "I bfs tau=0.3",
        options: {
            traversal: "bfs",
            probeComposition: "union",
            anchorScoring: { kind: "weighted-probe-density", tau: 0.3 },
        },
    },
    {
        label: "I bfs tau=0.4",
        options: {
            traversal: "bfs",
            probeComposition: "union",
            anchorScoring: { kind: "weighted-probe-density", tau: 0.4 },
        },
    },
    {
        label: "I dijkstra tmp=0.5 tau=0.3",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            probeComposition: "union",
            anchorScoring: { kind: "weighted-probe-density", tau: 0.3 },
        },
    },
    // --- Phase 2.3 Option J (non-linear probe-coverage anchor scoring) ---
    {
        label: "J bfs cov-bonus exp=2 tau=0.2",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.2, exponent: 2 },
        },
    },
    {
        label: "J bfs cov-bonus exp=2 tau=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "density-coverage-bonus", tau: 0.3, exponent: 2 },
        },
    },
    {
        label: "J bfs min-gate tau=0.1",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "min-cosine-gate", tau: 0.1 },
        },
    },
    {
        label: "J bfs min-gate tau=0.2",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "min-cosine-gate", tau: 0.2 },
        },
    },
    // --- Phase 2.5 Option L (expand anchor candidate set) — eval-A watch --
    // Primary criterion is eval-B (iterative-sweep); these rows only exist
    // to gate the ±0.02 regression check against the "A3 bfs
    // probe=weighted-fusion tau=0.2" row above (eval-A's Phase-2.1 proxy —
    // session-decay isn't plumbed through sweep.ts's one-shot queries).
    {
        label: "L bfs wfusion tau=0.2 anchorTopK=10",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            anchorTopK: 10,
        },
    },
    {
        label: "L bfs wfusion tau=0.2 anchorTopK=15",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            anchorTopK: 15,
        },
    },
    // --- Phase 2.6 Option M (idf-weighted-fusion) — eval-A watch ----------
    // Primary criterion remains eval-B (iterative-sweep); these rows exist
    // so the ±0.02 regression check is legible in the same artifact.
    // Baseline reference: "A3 bfs probe=weighted-fusion tau=0.2" (0.510
    // tier-1 / 0.548 tier-2). α=0 must not move vs. the Option I τ=0.2
    // row that already lives in this file.
    {
        label: "M bfs idf-fusion τ=0.2 α=0 (isolation)",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0 },
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=0.5",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.5 },
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=1.0",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 1.0 },
        },
    },
    // --- Phase 2.10 Option O (spreading-activation) — eval-A gate ---------
    // SYNAPSE-inspired spreading activation + non-symmetric top-M lateral
    // inhibition over the seeded anchor set. Phase 2.8 baseline for the
    // gate is "dijkstra tmp=0.5" + weighted-fusion τ=0.2 (see CONTEXT.md
    // § Phase 2.8 — 0.703 tier-1 / 0.627 tier-2). All Option-O rows pin
    // traversal to dijkstra+tmp=0.5 so eval-A movement is attributable to
    // the new anchor scorer, not the traversal change.
    //
    // Primary sweep (16 rows): initialTopK × maxHops × decay × inhibitionTopM,
    // fixing spreadingFactor=0.8, inhibitionStrength=0.15 at paper defaults.
    // Ablation (5 rows) varies one of {β, S} at a time around the central
    // base (initialTopK=5, maxHops=3, decay=0.5, M=7), plus a no-inhibition
    // isolation row (the direct equivalent of SYNAPSE Table 3's adversarial
    // ablation 96.6→71.5 F1).
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
        // Ablation around central base (K0=5, T=3, δ=0.5, M=7).
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
    // 7.7× edge-concentration signal. These rows check whether the gate
    // regresses eval-A on scatter queries (where rolling-session concentration
    // cannot emerge within a single run) and whether any (K, penalty) config
    // holds the Phase-2.8 default baseline 0.703/0.627.
    //
    // All rows pin to Phase-2.8 default traversal (`dijkstra` +
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
    // Phase 2.14 — winner rows from the eval-B decay sweep (bfs wfusion τ=0.2
    // + decay ∈ {0.1, 0.2}). Single-turn eval-A doesn't exercise
    // sessionDecayTau directly, but including these rows confirms no silent
    // regression vs the Phase-2.13 BGE-base eval-A floor (0.627 baseline,
    // 0.649 best).
    {
        label: "2.14 bfs wfusion τ=0.2 + decay=0.2",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            sessionDecayTau: 0.2,
        },
    },
    {
        label: "2.14 bfs wfusion τ=0.2 + decay=0.1",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
            sessionDecayTau: 0.1,
        },
    },
];

// Tier-3 validation sweep (Phase 2.7). Per CONTEXT.md §1828 this is a
// narrow validation of Option M, not a re-sweep of the Phase-2 design
// space — the six rows below are: vanilla BFS, the Phase-2.1 baseline
// (`weighted-fusion τ=0.2`), and Option M at α ∈ {0.3, 0.5, 0.7, 1.0}.
const CONFIGS_TIER3: Config[] = [
    { label: "baseline bfs", options: { traversal: "bfs" } },
    {
        label: "baseline-2.1 bfs wfusion τ=0.2",
        options: {
            traversal: "bfs",
            probeComposition: "weighted-fusion",
            weightedFusionTau: 0.2,
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=0.3",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.3 },
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=0.5",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.5 },
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=0.7",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 0.7 },
        },
    },
    {
        label: "M bfs idf-fusion τ=0.2 α=1.0",
        options: {
            traversal: "bfs",
            anchorScoring: { kind: "idf-weighted-fusion", tau: 0.2, alpha: 1.0 },
        },
    },
];

// Phase-2.13 narrow matrix: baseline bfs, Phase 2.8 default
// (dijkstra tmp=0.5 + wfusion τ=0.2), plus BGE-small's top tier-2 rows
// (dijkstra tmp=0.5, J bfs min-gate τ ∈ {0.1, 0.2}) and bfs wfusion τ=0.2
// for a without-Dijkstra control. Pruned primitives (L, M α≥0.5, A1, H,
// J density, sessionDecay) are excluded per path_memory_phase28 memory.
const PHASE_213_LABELS = new Set<string>([
    "bfs (default)",
    "dijkstra tmp=0.5",
    "A3 bfs probe=weighted-fusion tau=0.2",
    "A3 dijkstra tmp=0.5 probe=weighted-fusion tau=0.2",
    "J bfs min-gate tau=0.1",
    "J bfs min-gate tau=0.2",
]);

// Phase-2.14 eval-A regression matrix: Phase-2.13 baselines + winner rows
// (bfs wfusion τ=0.2 + decay ∈ {0.1, 0.2}) to verify no eval-A regression
// below Phase-2.13's 0.649 floor.
const PHASE_214_LABELS = new Set<string>([
    "bfs (default)",
    "A3 bfs probe=weighted-fusion tau=0.2",
    "2.14 bfs wfusion τ=0.2 + decay=0.2",
    "2.14 bfs wfusion τ=0.2 + decay=0.1",
]);

const CONFIG_SET = (process.env.CONFIG_SET ?? "").toLowerCase();

const ACTIVE_CONFIGS =
    CONFIG_SET === "phase213"
        ? CONFIGS.filter((c) => PHASE_213_LABELS.has(c.label))
        : CONFIG_SET === "phase214"
          ? CONFIGS.filter((c) => PHASE_214_LABELS.has(c.label))
          : TIER === "tier3"
            ? CONFIGS_TIER3
            : CONFIGS;

type ConfigResult = {
    mean: number;
    wins: number;
    losses: number;
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
        lexicalIdfFloor: config.lexicalIdfFloor,
        temporalDecayTau: config.temporalDecayTau,
    });
    const baseline = new FlatVectorBaseline(embedder, memory.store);

    for (const c of DATASET.claims) {
        await memory.ingest({
            id: c.id,
            text: c.text,
            validFrom: c.validFrom,
            supersedes: c.supersedes,
        });
    }

    let pathSum = 0;
    let wins = 0;
    let losses = 0;
    for (const q of DATASET.queries) {
        const ideal = new Set(q.ideal);
        const k = Math.max(1, ideal.size);
        const paths = await memory.queryWithProbes(q.probes, {
            mode: q.mode,
            anchorTopK: 5,
            resultTopN: 10,
            accessTracking: true,
            ...config.options,
        });
        const pathClaims = rankClaims(paths).slice(0, k);
        const baseRanks = await baseline.query(q.naturalQuery, { topK: k, mode: q.mode });
        const baseClaims = baseRanks.map((r) => r.id);
        const pF = f1(ideal, pathClaims);
        const bF = f1(ideal, baseClaims);
        pathSum += pF;
        if (pF > bF + 1e-6) wins++;
        else if (bF > pF + 1e-6) losses++;
    }

    const snap = memory.graph.accessStatsSnapshot();
    const topNodeCount = snap.nodes.slice(0, 5).reduce((s, n) => s + n.count, 0);
    const topEdgeCount = snap.edges.slice(0, 5).reduce((s, e) => s + e.count, 0);
    return {
        mean: pathSum / DATASET.queries.length,
        wins,
        losses,
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
        `# sweep tier=${TIER}  (claims=${DATASET.claims.length}, queries=${DATASET.queries.length})`,
    );
    console.log(
        `config | mean-path-F1 | wins | losses | nodeBumps(distinct) | top5-share | edgeBumps(distinct) | top5-share`,
    );
    for (const cfg of ACTIVE_CONFIGS) {
        const r = await runConfig(cfg);
        console.log(
            [
                cfg.label.padEnd(42),
                r.mean.toFixed(3),
                `${r.wins}`,
                `${r.losses}`,
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
