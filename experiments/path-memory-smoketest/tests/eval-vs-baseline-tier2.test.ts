import { describe, test, expect } from "bun:test";
import { getEmbedder } from "../src/embedder.js";
import { PathMemory } from "../src/interfaces.js";
import { FlatVectorBaseline } from "../eval/baseline.js";
import { tier2Greek } from "../data/tier2-greek.js";
import { queriesTier2 } from "../eval/queries-tier2.js";
import type { ClaimId, ScoredPath } from "../src/types.js";

type Score = { precision: number; recall: number; f1: number };

function f1AtK(ideal: Set<ClaimId>, predicted: ClaimId[]): Score {
    if (predicted.length === 0 || ideal.size === 0) return { precision: 0, recall: 0, f1: 0 };
    let hits = 0;
    for (const id of predicted) if (ideal.has(id)) hits++;
    const precision = hits / predicted.length;
    const recall = hits / ideal.size;
    const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { precision, recall, f1: f };
}

function rankClaimsFromPaths(paths: ScoredPath[]): ClaimId[] {
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

describe("eval (A) — path retriever vs flat vector baseline (tier 2)", () => {
    test("path retriever at least ties baseline on tier-2 Greek-history queries", async () => {
        const embedder = await getEmbedder();
        const memory = new PathMemory({ embedder });
        const baseline = new FlatVectorBaseline(embedder, memory.store);

        for (const c of tier2Greek) {
            await memory.ingest({
                id: c.id,
                text: c.text,
                validFrom: c.validFrom,
                supersedes: c.supersedes,
            });
        }

        let pathWins = 0;
        let baselineWins = 0;
        let ties = 0;
        let pathF1Sum = 0;
        let baselineF1Sum = 0;
        const rows: string[] = [];

        for (const q of queriesTier2) {
            const ideal = new Set(q.ideal);
            const k = Math.max(1, ideal.size);

            const pathResults = await memory.queryWithProbes(q.probes, {
                mode: q.mode,
                anchorTopK: 5,
                resultTopN: 10,
            });
            const pathClaims = rankClaimsFromPaths(pathResults).slice(0, k);

            const baselineResults = await baseline.query(q.naturalQuery, {
                topK: k,
                mode: q.mode,
            });
            const baselineClaims = baselineResults.map((r) => r.id);

            const pathScore = f1AtK(ideal, pathClaims);
            const baselineScore = f1AtK(ideal, baselineClaims);
            pathF1Sum += pathScore.f1;
            baselineF1Sum += baselineScore.f1;

            let outcome: string;
            if (pathScore.f1 > baselineScore.f1 + 1e-6) {
                pathWins++;
                outcome = "PATH";
            } else if (baselineScore.f1 > pathScore.f1 + 1e-6) {
                baselineWins++;
                outcome = "BASE";
            } else {
                ties++;
                outcome = "tie ";
            }

            rows.push(
                `  [${outcome}] k=${k.toString().padStart(2)}  ${q.name.padEnd(40)}  path F1=${pathScore.f1.toFixed(2)}  base F1=${baselineScore.f1.toFixed(2)}`,
            );
        }

        const total = queriesTier2.length;
        console.log(`\n=== Tier 2 eval-vs-baseline (P/R @ K=|ideal|) ===`);
        console.log(
            `Queries: ${total}    path wins: ${pathWins}    baseline wins: ${baselineWins}    ties: ${ties}`,
        );
        console.log(
            `Mean F1 — path: ${(pathF1Sum / total).toFixed(3)}    baseline: ${(baselineF1Sum / total).toFixed(3)}`,
        );
        for (const r of rows) console.log(r);

        expect(pathWins + ties).toBeGreaterThanOrEqual(baselineWins);
    }, 180_000);
});
