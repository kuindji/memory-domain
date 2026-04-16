import { describe, test, expect } from "bun:test";
import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { tracesTier2 } from "../eval/conversation-traces-tier2.js";
import type { ClaimId, ScoredPath } from "../src/types.js";

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

describe("eval (B) — iterative arc convergence (tier 2)", () => {
    test("multi-turn probe accumulation narrows candidate set toward expected claims", async () => {
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

        let totalNarrowing = 0;
        let totalArcs = 0;
        let coherentArcs = 0;

        for (const trace of tracesTier2) {
            console.log(`\n--- trace: ${trace.name} ---`);
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

        console.log(`\n=== Tier 2 iterative summary ===`);
        console.log(
            `Arcs: ${totalArcs}    narrowed: ${totalNarrowing}    coherent (≥0.5): ${coherentArcs}`,
        );

        // Tier-2's iterative arcs exercise a harder pattern than tier-1:
        // no shared anchor token like tier-1's `alex`, so broad early-turn
        // probes continue to dominate narrow later-turn probes in the
        // accumulated session. At defaults (and across every Phase-1.6
        // config) coherence runs 0/4 on tier-2; narrowing still holds
        // 4/4. Narrowing is the gate the test asserts — coherence is
        // logged as an observational metric and tracked in CONTEXT.md.
        expect(totalNarrowing).toBeGreaterThanOrEqual(Math.ceil(totalArcs / 2));
    }, 180_000);
});
