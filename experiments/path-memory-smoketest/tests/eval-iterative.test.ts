import { describe, test, expect } from "bun:test";
import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { tier1Alex } from "../data/tier1-alex.js";
import { tracesTier1 } from "../eval/conversation-traces-tier1.js";
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

    for (const trace of tracesTier1) {
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

describe("eval (B) — iterative arc convergence (tier 1)", () => {
    test("multi-turn probe accumulation converges; sessionDecayTau does not regress tier-1", async () => {
        const embedder = await getEmbedder();
        const memory = new PathMemory({ embedder });

        for (const c of tier1Alex) {
            await memory.ingest({
                id: c.id,
                text: c.text,
                validFrom: c.validFrom,
                supersedes: c.supersedes,
            });
        }

        // Baseline (post-Phase-2.1 default: weighted-fusion τ=0.2). With the
        // default flip alone, tier-1 coherence holds — at least ceil(arcs/2)
        // arcs converge to overlap ≥ 0.5 on the final turn.
        const baseline = await runArcs(memory, {}, "defaults (no session decay)");
        const passFloor = Math.ceil(baseline.arcs / 2);
        expect(baseline.coherent).toBeGreaterThanOrEqual(passFloor);

        // Regression guard for Option E: enabling sessionDecayTau on tier-1
        // should not drop coherence below the same pass floor. Tier-1's
        // shared-anchor (`alex`) shape made it work without recency
        // weighting; we just want to confirm decay doesn't break it.
        const decayed = await runArcs(
            memory,
            { sessionDecayTau: 1.0 },
            "sessionDecayTau=1.0 (Phase 2.1)",
        );
        expect(decayed.coherent).toBeGreaterThanOrEqual(passFloor);
    }, 180_000);
});
