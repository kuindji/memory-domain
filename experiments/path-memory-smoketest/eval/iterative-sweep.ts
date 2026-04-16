import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { tier1Alex } from "../data/tier1-alex.js";
import { tracesTier1 } from "./conversation-traces-tier1.js";
import type { ClaimId, RetrievalOptions, ScoredPath } from "../src/types.js";

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

const CONFIGS: Config[] = [
    { label: "bfs (default)", options: {} },
    {
        label: "A2 dijkstra tmp=0.5 anchor=idf alpha=0.7",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.7 },
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
        label: "A2+A3 dijkstra anchor=idf a=0.7 probe=intersection",
        options: {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
            anchorScoring: { kind: "cosine-idf-mass", alpha: 0.7 },
            probeComposition: "intersection",
        },
    },
];

async function runConfig(config: Config): Promise<{
    narrowed: number;
    coherent: number;
    arcs: number;
}> {
    const embedder = await getEmbedder();
    const memory = new PathMemory({
        embedder,
        temporalDecayTau: config.temporalDecayTau,
    });
    for (const c of tier1Alex) {
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

    for (const trace of tracesTier1) {
        const session = memory.createSession();
        const sizeAcrossTurns: number[] = [];
        let lastTopClaims: Set<ClaimId> = new Set();

        for (const turn of trace.turns) {
            await session.addProbeSentences(turn.probes);
            const results = session.retrieve({
                mode: trace.mode,
                anchorTopK: 5,
                resultTopN: 10,
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
        if (last <= first) narrowed++;

        const finalExpected = new Set(
            trace.turns[trace.turns.length - 1].expectedClaimsAfterThisTurn,
        );
        const coverage =
            finalExpected.size > 0
                ? intersectionSize(finalExpected, lastTopClaims) / finalExpected.size
                : 0;
        if (coverage >= 0.5) coherent++;
        arcs++;
    }

    return { narrowed, coherent, arcs };
}

async function main(): Promise<void> {
    console.log(`config | narrowed | coherent`);
    for (const cfg of CONFIGS) {
        const r = await runConfig(cfg);
        console.log(
            `${cfg.label.padEnd(48)} | ${r.narrowed}/${r.arcs}      | ${r.coherent}/${r.arcs}`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
