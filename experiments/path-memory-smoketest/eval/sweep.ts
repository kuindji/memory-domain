import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { FlatVectorBaseline } from "./baseline.js";
import { tier1Alex } from "../data/tier1-alex.js";
import { queriesTier1 } from "./queries-tier1.js";
import type { ClaimId, ScoredPath, RetrievalOptions } from "../src/types.js";

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
    options: RetrievalOptions;
};

const CONFIGS: Config[] = [
    // --- BFS baseline (Phase 1 default) for reference ---
    { label: "bfs (default)", options: { traversal: "bfs" } },
    // --- Phase 1.5 Dijkstra: temporalHopCost sweep at pq=0 ---
    {
        label: "dijkstra tmp=0.0, pq=0",
        options: { traversal: "dijkstra", temporalHopCost: 0 },
    },
    {
        label: "dijkstra tmp=0.3, pq=0",
        options: { traversal: "dijkstra", temporalHopCost: 0.3 },
    },
    {
        label: "dijkstra tmp=0.5, pq=0",
        options: { traversal: "dijkstra", temporalHopCost: 0.5 },
    },
    {
        label: "dijkstra tmp=0.7, pq=0",
        options: { traversal: "dijkstra", temporalHopCost: 0.7 },
    },
    {
        label: "dijkstra tmp=1.0, pq=0",
        options: { traversal: "dijkstra", temporalHopCost: 1.0 },
    },
    // --- Dijkstra + pathQuality combos ---
    {
        label: "dijkstra tmp=0.5, pq=0.3",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            weights: { pathQuality: 0.3 },
        },
    },
    {
        label: "dijkstra tmp=0.7, pq=0.3",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.7,
            weights: { pathQuality: 0.3 },
        },
    },
    // --- Dijkstra + lexicalIdfFloor ---
    {
        label: "dijkstra tmp=0.5, floor=0.15, pq=0.3",
        lexicalIdfFloor: 0.15,
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            weights: { pathQuality: 0.3 },
        },
    },
];

async function runConfig(config: Config): Promise<{ mean: number; wins: number; losses: number }> {
    const embedder = await getEmbedder();
    const memory = new PathMemory({ embedder, lexicalIdfFloor: config.lexicalIdfFloor });
    const baseline = new FlatVectorBaseline(embedder, memory.store);

    for (const c of tier1Alex) {
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
    for (const q of queriesTier1) {
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
    return { mean: pathSum / queriesTier1.length, wins, losses };
}

async function main(): Promise<void> {
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
