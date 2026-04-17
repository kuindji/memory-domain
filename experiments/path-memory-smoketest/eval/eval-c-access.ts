import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { tracesRepeatUser, type RepeatUserTrace } from "./traces-repeat-user.js";
import type { RetrievalOptions, ScoredPath } from "../src/types.js";

// Phase 2.9 — eval-C: repeat-user access-concentration measurement.
//
// Runs a fixed Phase-2.8-default retrieval config against multi-session
// "repeat user" traces and reports per-trace access concentration. Pass
// criterion (from PLAN-post-2.8.md § "Phase 2.9"):
//   top-5 edge share >= 5x uniform baseline on at least half of traces.

const PHASE_2_8_DEFAULT: RetrievalOptions = {
    traversal: "dijkstra",
    temporalHopCost: 0.5,
    probeComposition: "weighted-fusion",
    weightedFusionTau: 0.2,
    anchorTopK: 5,
    resultTopN: 10,
    accessTracking: true,
};

const EDGE_RATIO_PASS_THRESHOLD = 5.0;

type TraceResult = {
    name: string;
    sessions: number;
    turns: number;
    distinctNodes: number;
    distinctEdges: number;
    nodeBumps: number;
    edgeBumps: number;
    top5NodeShare: number;
    top5EdgeShare: number;
    nodeRatio: number;
    edgeRatio: number;
    repeatingPathSets: number;
    sessionPathSetSignatures: string[];
};

function pathSignature(paths: ScoredPath[], topN: number): string {
    const sorted = [...paths].sort((a, b) => b.score - a.score).slice(0, topN);
    const sets = sorted.map((p) => [...p.path.nodeIds].sort().join(","));
    return sets.join("|");
}

async function runTrace(trace: RepeatUserTrace): Promise<TraceResult> {
    const embedder = await getEmbedder();
    const memory = new PathMemory({ embedder });
    for (const c of tier2Greek) {
        await memory.ingest({
            id: c.id,
            text: c.text,
            validFrom: c.validFrom,
            supersedes: c.supersedes,
        });
    }

    let turnCount = 0;
    const sessionSignatures: string[] = [];

    for (const sessionBlock of trace.sessions) {
        const session = memory.createSession();
        const sessionPaths: ScoredPath[] = [];
        for (const turn of sessionBlock.turns) {
            await session.addProbeSentences(turn.probes);
            const results = session.retrieve({
                mode: trace.mode,
                ...PHASE_2_8_DEFAULT,
            });
            turnCount++;
            sessionPaths.length = 0;
            sessionPaths.push(...results);
        }
        sessionSignatures.push(pathSignature(sessionPaths, 3));
    }

    const signatureCounts = new Map<string, number>();
    for (const sig of sessionSignatures) {
        if (sig.length === 0) continue;
        signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
    }
    let repeatingPathSets = 0;
    for (const count of signatureCounts.values()) {
        if (count >= 2) repeatingPathSets += count;
    }

    const snap = memory.graph.accessStatsSnapshot();
    const top5NodeCount = snap.nodes.slice(0, 5).reduce((s, n) => s + n.count, 0);
    const top5EdgeCount = snap.edges.slice(0, 5).reduce((s, e) => s + e.count, 0);
    const top5NodeShare = snap.totals.nodeBumps > 0 ? top5NodeCount / snap.totals.nodeBumps : 0;
    const top5EdgeShare = snap.totals.edgeBumps > 0 ? top5EdgeCount / snap.totals.edgeBumps : 0;
    const uniformNodeBase = snap.totals.distinctNodes > 0 ? 5 / snap.totals.distinctNodes : 0;
    const uniformEdgeBase = snap.totals.distinctEdges > 0 ? 5 / snap.totals.distinctEdges : 0;
    const nodeRatio = uniformNodeBase > 0 ? top5NodeShare / uniformNodeBase : 0;
    const edgeRatio = uniformEdgeBase > 0 ? top5EdgeShare / uniformEdgeBase : 0;

    return {
        name: trace.name,
        sessions: trace.sessions.length,
        turns: turnCount,
        distinctNodes: snap.totals.distinctNodes,
        distinctEdges: snap.totals.distinctEdges,
        nodeBumps: snap.totals.nodeBumps,
        edgeBumps: snap.totals.edgeBumps,
        top5NodeShare,
        top5EdgeShare,
        nodeRatio,
        edgeRatio,
        repeatingPathSets,
        sessionPathSetSignatures: sessionSignatures,
    };
}

function fmt(n: number, digits = 3): string {
    return n.toFixed(digits);
}

async function main(): Promise<void> {
    console.log("# eval-C repeat-user access concentration (tier2, Phase 2.8 default)");
    console.log(
        "trace | sessions | turns | distinctNodes | distinctEdges | top5NodeShare | nodeRatio | top5EdgeShare | edgeRatio | repeatingPaths",
    );

    const results: TraceResult[] = [];
    for (const trace of tracesRepeatUser) {
        const r = await runTrace(trace);
        results.push(r);
        console.log(
            [
                r.name.padEnd(40),
                r.sessions,
                r.turns,
                r.distinctNodes,
                r.distinctEdges,
                fmt(r.top5NodeShare),
                fmt(r.nodeRatio, 2),
                fmt(r.top5EdgeShare),
                fmt(r.edgeRatio, 2),
                r.repeatingPathSets,
            ].join(" | "),
        );
    }

    console.log("-----");
    const passing = results.filter((r) => r.edgeRatio >= EDGE_RATIO_PASS_THRESHOLD).length;
    const half = Math.ceil(results.length / 2);
    const verdict = passing >= half ? "PASS" : "FAIL";
    console.log(
        `Pass count: ${passing}/${results.length} traces with edgeRatio >= ${EDGE_RATIO_PASS_THRESHOLD.toFixed(1)} (threshold: >= ${half})`,
    );
    console.log(`Verdict: ${verdict}`);

    const meanNodeRatio =
        results.reduce((s, r) => s + r.nodeRatio, 0) / Math.max(1, results.length);
    const meanEdgeRatio =
        results.reduce((s, r) => s + r.edgeRatio, 0) / Math.max(1, results.length);
    console.log(
        `Mean ratios across traces: nodeRatio=${fmt(meanNodeRatio, 2)}, edgeRatio=${fmt(meanEdgeRatio, 2)}`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
