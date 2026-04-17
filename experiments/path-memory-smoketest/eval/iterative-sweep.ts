import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { tier1Alex } from "../data/tier1-alex.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { tracesTier1 } from "./conversation-traces-tier1.js";
import { tracesTier2 } from "./conversation-traces-tier2.js";
import type { ClaimId, RetrievalOptions, ScoredPath } from "../src/types.js";

const TIER = (process.env.TIER ?? "tier1").toLowerCase();
const DATASET =
    TIER === "tier2"
        ? { claims: tier2Greek, traces: tracesTier2 }
        : { claims: tier1Alex, traces: tracesTier1 };

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

    for (const trace of DATASET.traces) {
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
    console.log(
        `# iterative-sweep tier=${TIER}  (claims=${DATASET.claims.length}, traces=${DATASET.traces.length})`,
    );
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
