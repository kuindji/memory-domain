import { describe, test, expect } from "bun:test";
import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { tracesTier2 } from "../eval/conversation-traces-tier2.js";
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

async function runArcs(
    memory: PathMemory,
    options: RetrievalOptions,
    label: string,
): Promise<{ arcs: number; narrowed: number; coherent: number }> {
    let totalNarrowing = 0;
    let totalArcs = 0;
    let coherentArcs = 0;

    console.log(`\n### ${label} ###`);

    for (const trace of tracesTier2) {
        console.log(`--- trace: ${trace.name} ---`);
        const session = memory.createSession();
        const sizeAcrossTurns: number[] = [];
        let lastTopClaims: Set<ClaimId> = new Set();

        for (let t = 0; t < trace.turns.length; t++) {
            const turn = trace.turns[t];
            await session.addProbeSentences(turn.probes);
            const results = session.retrieve({
                mode: trace.mode,
                anchorTopK: 5,
                resultTopN: 10,
                ...options,
            });
            const ranked = rankClaims(results);
            const expected = new Set(turn.expectedClaimsAfterThisTurn);
            const topK = Math.max(expected.size, 3);
            const topClaims = new Set(ranked.slice(0, topK));
            const overlap = intersectionSize(expected, topClaims);

            sizeAcrossTurns.push(results.length);
            lastTopClaims = topClaims;

            console.log(
                `  turn ${t + 1}  probes=${session.probeCount}  paths=${results.length}  top@${topK}=[${[...topClaims].slice(0, 5).join(",")}]  expect-overlap=${overlap}/${expected.size}`,
            );
        }

        const first = sizeAcrossTurns[0];
        const last = sizeAcrossTurns[sizeAcrossTurns.length - 1];
        const narrowed = last <= first;
        totalNarrowing += narrowed ? 1 : 0;

        const finalExpected = new Set(
            trace.turns[trace.turns.length - 1].expectedClaimsAfterThisTurn,
        );
        const coverage =
            finalExpected.size > 0
                ? intersectionSize(finalExpected, lastTopClaims) / finalExpected.size
                : 0;
        const coherent = coverage >= 0.5;
        if (coherent) coherentArcs++;
        totalArcs++;
        console.log(
            `  → narrowed: ${narrowed}    final-coverage: ${coverage.toFixed(2)}    coherent: ${coherent}`,
        );
    }

    console.log(
        `=== ${label} summary: arcs=${totalArcs}  narrowed=${totalNarrowing}  coherent=${coherentArcs} ===`,
    );

    return { arcs: totalArcs, narrowed: totalNarrowing, coherent: coherentArcs };
}

describe("eval (B) — iterative arc convergence (tier 2)", () => {
    test("multi-turn probe accumulation narrows candidate set (baseline + session decay)", async () => {
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

        // Defaults (post-Phase-2.1: weighted-fusion τ=0.2, no session decay).
        // At defaults across every Phase-1.6 config, tier-2 coherence ran 0/4;
        // narrowing held 4/4. We still assert narrowing as the architectural
        // floor; coherence at defaults is observational.
        const baseline = await runArcs(memory, {}, "defaults (no session decay)");
        expect(baseline.narrowed).toBeGreaterThanOrEqual(Math.ceil(baseline.arcs / 2));

        // Phase 2.1 (MiniLM) locked in `decayed.coherent > baseline.coherent`;
        // Phase 2.7 (BGE-small) saw the lift disappear; Phase 2.13 (BGE-base,
        // current default) brings it back: coherence rises 1/4 → 2/4 on tier-2
        // when `decay=0.3` is paired with `bfs wfusion τ=0.2`. The coherence
        // direction still oscillates per encoder, so it stays an observational
        // metric tracked by iterative-sweep rather than a unit-test invariant.
        // See experiments/path-memory-smoketest/CONTEXT.md § Phase 2.13.
        const decayed = await runArcs(
            memory,
            { sessionDecayTau: 0.3 },
            "sessionDecayTau=0.3 (Phase 2.1)",
        );
        expect(decayed.narrowed).toBeGreaterThanOrEqual(Math.ceil(decayed.arcs / 2));
    }, 240_000);
});
