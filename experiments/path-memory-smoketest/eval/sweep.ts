import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { FlatVectorBaseline } from "./baseline.js";
import { tier1Alex } from "../data/tier1-alex.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { queriesTier1 } from "./queries-tier1.js";
import { queriesTier2 } from "./queries-tier2.js";
import type { ClaimId, ScoredPath, RetrievalOptions } from "../src/types.js";

// Select tier via TIER env var. Default is tier1 for back-compat with
// pre-Phase-2 invocations; TIER=tier2 selects the Greek-history corpus.
const TIER = (process.env.TIER ?? "tier1").toLowerCase();
const DATASET =
    TIER === "tier2"
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
];

async function runConfig(config: Config): Promise<{ mean: number; wins: number; losses: number }> {
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
    return { mean: pathSum / DATASET.queries.length, wins, losses };
}

async function main(): Promise<void> {
    console.log(
        `# sweep tier=${TIER}  (claims=${DATASET.claims.length}, queries=${DATASET.queries.length})`,
    );
    console.log(`config | mean-path-F1 | wins | losses`);
    for (const cfg of CONFIGS) {
        const r = await runConfig(cfg);
        console.log(
            `${cfg.label.padEnd(38)} | ${r.mean.toFixed(3)}        | ${r.wins}    | ${r.losses}`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
