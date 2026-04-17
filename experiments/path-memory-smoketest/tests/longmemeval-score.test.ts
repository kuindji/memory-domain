import { describe, test, expect } from "bun:test";
import {
    aggregateByCategory,
    aggregateOverall,
    scoreLongMemEval,
    scoreResult,
} from "../eval/longmemeval-score.js";
import type { LongMemEvalQuestionResult } from "../eval/longmemeval-adapter.js";

// Phase 7 — rule-based scorer tests. Crafted synthetic `LongMemEvalQuestionResult`
// objects avoid having to run retrieval; scoring is a pure function over the
// adapter's output.

function makeResult(
    overrides: Partial<LongMemEvalQuestionResult> &
        Pick<LongMemEvalQuestionResult, "questionId" | "category" | "goldAnswer"> & {
            retrievedClaimTexts: string[];
        },
): LongMemEvalQuestionResult {
    return {
        questionId: overrides.questionId,
        category: overrides.category,
        questionText: overrides.questionText ?? "placeholder?",
        goldAnswer: overrides.goldAnswer,
        ingestedClaimCount: overrides.ingestedClaimCount ?? 0,
        topPaths: overrides.topPaths ?? [],
        retrievedClaimIds:
            overrides.retrievedClaimIds ?? overrides.retrievedClaimTexts.map((_, i) => `c${i}`),
        retrievedClaimTexts: overrides.retrievedClaimTexts,
        ingestMs: overrides.ingestMs ?? 0,
        retrieveMs: overrides.retrieveMs ?? 0,
    };
}

describe("scoreResult — substring containment", () => {
    test("hits when gold answer appears in retrieved text", () => {
        const r = makeResult({
            questionId: "q1",
            category: "single-session-user",
            goldAnswer: "Boston",
            retrievedClaimTexts: [
                "Alex grew up in Boston Massachusetts",
                "Cambridge was his next home",
            ],
        });
        const score = scoreResult(r);
        expect(score.metrics.substringContainment).toBe(true);
        expect(score.metrics.substringFirstRank).toBe(0);
        expect(score.metrics.tokenRecall).toBe(1);
        expect(score.metrics.fullTokenCoverage).toBe(true);
    });

    test("misses when gold answer is absent", () => {
        const r = makeResult({
            questionId: "q2",
            category: "single-session-user",
            goldAnswer: "Denver",
            retrievedClaimTexts: ["Alex grew up in Boston", "Cambridge was his next home"],
        });
        const score = scoreResult(r);
        expect(score.metrics.substringContainment).toBe(false);
        expect(score.metrics.substringFirstRank).toBe(-1);
        expect(score.metrics.tokenRecall).toBe(0);
        expect(score.metrics.fullTokenCoverage).toBe(false);
    });

    test("case-insensitive substring containment", () => {
        const r = makeResult({
            questionId: "q3",
            category: "single-session-user",
            goldAnswer: "BOSTON",
            retrievedClaimTexts: ["alex grew up in boston"],
        });
        expect(scoreResult(r).metrics.substringContainment).toBe(true);
    });

    test("substringFirstRank reflects the first matching claim", () => {
        const r = makeResult({
            questionId: "q4",
            category: "multi-session",
            goldAnswer: "hiking",
            retrievedClaimTexts: [
                "alex likes cooking",
                "alex plays chess",
                "alex took up hiking on weekends",
            ],
        });
        expect(scoreResult(r).metrics.substringFirstRank).toBe(2);
    });
});

describe("scoreResult — token metrics", () => {
    test("partial token recall when some gold tokens are missing", () => {
        const r = makeResult({
            questionId: "q5",
            category: "temporal-reasoning",
            // Two content tokens after stopword filter: "moved", "cambridge"
            goldAnswer: "moved to Cambridge",
            retrievedClaimTexts: ["Cambridge was his college town"],
        });
        const score = scoreResult(r);
        expect(score.metrics.tokenRecall).toBeCloseTo(0.5, 5);
        expect(score.metrics.fullTokenCoverage).toBe(false);
        expect(score.metrics.substringContainment).toBe(false);
    });

    test("gold with only stopwords yields zero", () => {
        const r = makeResult({
            questionId: "q6",
            category: "single-session-user",
            goldAnswer: "the of a",
            retrievedClaimTexts: ["alex grew up in Boston"],
        });
        const score = scoreResult(r);
        expect(score.metrics.goldTokenCount).toBe(0);
        expect(score.metrics.tokenRecall).toBe(0);
        expect(score.metrics.tokenF1).toBe(0);
        expect(score.metrics.fullTokenCoverage).toBe(false);
    });

    test("empty retrieved context yields zero recall, no substring", () => {
        const r = makeResult({
            questionId: "q7",
            category: "single-session-user",
            goldAnswer: "Boston",
            retrievedClaimTexts: [],
        });
        const score = scoreResult(r);
        expect(score.metrics.substringContainment).toBe(false);
        expect(score.metrics.tokenRecall).toBe(0);
        expect(score.metrics.substringFirstRank).toBe(-1);
    });
});

describe("aggregateByCategory / aggregateOverall", () => {
    const results = [
        makeResult({
            questionId: "a1",
            category: "single-session-user",
            goldAnswer: "Boston",
            retrievedClaimTexts: ["grew up in Boston"],
        }),
        makeResult({
            questionId: "a2",
            category: "single-session-user",
            goldAnswer: "Denver",
            retrievedClaimTexts: ["grew up in Boston"],
        }),
        makeResult({
            questionId: "t1",
            category: "temporal-reasoning",
            goldAnswer: "college",
            retrievedClaimTexts: ["moved to Cambridge during college"],
        }),
    ];

    test("aggregateByCategory computes containment rate per category", () => {
        const scores = scoreLongMemEval(results);
        const agg = aggregateByCategory(scores);
        const catMap = new Map(agg.map((a) => [a.category, a]));

        const singleUser = catMap.get("single-session-user");
        expect(singleUser?.count).toBe(2);
        expect(singleUser?.substringContainmentRate).toBe(0.5);
        expect(singleUser?.unreachableCount).toBe(1);

        const temporal = catMap.get("temporal-reasoning");
        expect(temporal?.count).toBe(1);
        expect(temporal?.substringContainmentRate).toBe(1);
    });

    test("aggregateOverall rolls per-question metrics into flat summary", () => {
        const scores = scoreLongMemEval(results);
        const overall = aggregateOverall(scores);
        expect(overall.count).toBe(3);
        expect(overall.substringContainmentRate).toBeCloseTo(2 / 3, 5);
        expect(overall.unreachableCount).toBe(1);
    });

    test("aggregateOverall on empty input returns zeroed aggregate", () => {
        const overall = aggregateOverall([]);
        expect(overall.count).toBe(0);
        expect(overall.substringContainmentRate).toBe(0);
        expect(overall.unreachableCount).toBe(0);
    });
});
