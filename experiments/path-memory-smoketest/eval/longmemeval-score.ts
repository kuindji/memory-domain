import { tokenize } from "../src/tokenize.js";
import type { LongMemEvalQuestionResult } from "./longmemeval-adapter.js";

// Phase 7 — rule-based LongMemEval scoring (no LLM judge).
//
// LongMemEval's published numbers (Memento 92.4%, Zep 71.2%, MAGMA 61.2%) are
// GPT-4o-as-judge scores on generated answers. Path-memory doesn't generate
// answers — it returns retrieved claim texts. These metrics score whether the
// retrieved context is **sufficient for a judge (LLM or human) to produce
// the gold answer**, not whether the system itself produced the answer.
// Numbers are therefore internally-comparable (across path-memory configs)
// but not apples-to-apples against peer systems until an LLM judge lands.

export type LongMemEvalMetricBundle = {
    // Substring containment: lowercased goldAnswer appears verbatim in the
    // concatenated retrieved-claim texts. Strong signal for short factual
    // answers (names, dates, places).
    substringContainment: boolean;

    // Rank of the first retrieved claim whose text substring-contains the
    // gold answer, or -1 if no claim contains it. Useful for diagnosing
    // whether the retriever ranks the answer-bearing claim near the top.
    substringFirstRank: number;

    // Token-level recall: fraction of gold-answer content tokens (after
    // stopword filtering) present in the retrieved-context token set.
    tokenRecall: number;

    // Token-level F1 over the raw retrieved context (long context pulls
    // precision down; included for completeness, not as a primary metric).
    tokenF1: number;

    // Coverage: every gold-answer content token appears somewhere in the
    // retrieved context. Boolean version of tokenRecall === 1.0.
    fullTokenCoverage: boolean;

    // Diagnostic counts — useful for aggregate sanity checks and for
    // deciding whether a scorer miss is a retrieval problem vs. a
    // gold-answer-is-empty edge case.
    goldTokenCount: number;
    contextTokenCount: number;
};

export type LongMemEvalScore = {
    questionId: string;
    category: string;
    metrics: LongMemEvalMetricBundle;
};

function buildContextString(result: LongMemEvalQuestionResult): string {
    return result.retrievedClaimTexts.join(" \n ");
}

function multisetIntersection(a: string[], b: string[]): number {
    const counts = new Map<string, number>();
    for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
    let overlap = 0;
    for (const t of b) {
        const remaining = counts.get(t) ?? 0;
        if (remaining > 0) {
            overlap += 1;
            counts.set(t, remaining - 1);
        }
    }
    return overlap;
}

function scoreMetrics(result: LongMemEvalQuestionResult): LongMemEvalMetricBundle {
    const context = buildContextString(result);
    const contextLower = context.toLowerCase();
    const goldLower = result.goldAnswer.toLowerCase().trim();

    const substringContainment = goldLower.length > 0 && contextLower.includes(goldLower);

    let substringFirstRank = -1;
    if (goldLower.length > 0) {
        for (let i = 0; i < result.retrievedClaimTexts.length; i++) {
            if (result.retrievedClaimTexts[i].toLowerCase().includes(goldLower)) {
                substringFirstRank = i;
                break;
            }
        }
    }

    const goldTokens = tokenize(result.goldAnswer);
    const contextTokens = tokenize(context);

    let tokenRecall = 0;
    let tokenF1 = 0;
    let fullTokenCoverage = false;
    if (goldTokens.length === 0) {
        // Can't score with empty gold tokens (e.g. gold = stopwords-only
        // string, or empty answer); leave zeroed.
    } else {
        const contextSet = new Set(contextTokens);
        let hits = 0;
        for (const token of goldTokens) if (contextSet.has(token)) hits += 1;
        tokenRecall = hits / goldTokens.length;
        fullTokenCoverage = hits === goldTokens.length;

        const intersection = multisetIntersection(goldTokens, contextTokens);
        const precision = contextTokens.length > 0 ? intersection / contextTokens.length : 0;
        const recallMultiset = goldTokens.length > 0 ? intersection / goldTokens.length : 0;
        tokenF1 =
            precision + recallMultiset > 0
                ? (2 * precision * recallMultiset) / (precision + recallMultiset)
                : 0;
    }

    return {
        substringContainment,
        substringFirstRank,
        tokenRecall,
        tokenF1,
        fullTokenCoverage,
        goldTokenCount: goldTokens.length,
        contextTokenCount: contextTokens.length,
    };
}

export function scoreResult(result: LongMemEvalQuestionResult): LongMemEvalScore {
    return {
        questionId: result.questionId,
        category: result.category,
        metrics: scoreMetrics(result),
    };
}

export function scoreLongMemEval(results: LongMemEvalQuestionResult[]): LongMemEvalScore[] {
    return results.map((r) => scoreResult(r));
}

export type LongMemEvalCategoryAggregate = {
    category: string;
    count: number;
    substringContainmentRate: number;
    fullTokenCoverageRate: number;
    meanTokenRecall: number;
    meanTokenF1: number;
    meanSubstringFirstRank: number;
    unreachableCount: number;
};

export function aggregateByCategory(scores: LongMemEvalScore[]): LongMemEvalCategoryAggregate[] {
    const buckets = new Map<string, LongMemEvalScore[]>();
    for (const s of scores) {
        const list = buckets.get(s.category) ?? [];
        list.push(s);
        buckets.set(s.category, list);
    }

    const out: LongMemEvalCategoryAggregate[] = [];
    const categories = Array.from(buckets.keys()).sort();
    for (const category of categories) {
        const entries = buckets.get(category);
        if (!entries || entries.length === 0) continue;
        const n = entries.length;
        let containHits = 0;
        let fullCoverageHits = 0;
        let recallSum = 0;
        let f1Sum = 0;
        let rankSum = 0;
        let rankHits = 0;
        let unreachable = 0;
        for (const s of entries) {
            if (s.metrics.substringContainment) containHits += 1;
            if (s.metrics.fullTokenCoverage) fullCoverageHits += 1;
            recallSum += s.metrics.tokenRecall;
            f1Sum += s.metrics.tokenF1;
            if (s.metrics.substringFirstRank >= 0) {
                rankSum += s.metrics.substringFirstRank;
                rankHits += 1;
            } else {
                unreachable += 1;
            }
        }
        out.push({
            category,
            count: n,
            substringContainmentRate: containHits / n,
            fullTokenCoverageRate: fullCoverageHits / n,
            meanTokenRecall: recallSum / n,
            meanTokenF1: f1Sum / n,
            meanSubstringFirstRank: rankHits > 0 ? rankSum / rankHits : -1,
            unreachableCount: unreachable,
        });
    }
    return out;
}

export type LongMemEvalOverallAggregate = {
    count: number;
    substringContainmentRate: number;
    fullTokenCoverageRate: number;
    meanTokenRecall: number;
    meanTokenF1: number;
    unreachableCount: number;
};

export function aggregateOverall(scores: LongMemEvalScore[]): LongMemEvalOverallAggregate {
    if (scores.length === 0) {
        return {
            count: 0,
            substringContainmentRate: 0,
            fullTokenCoverageRate: 0,
            meanTokenRecall: 0,
            meanTokenF1: 0,
            unreachableCount: 0,
        };
    }
    let contain = 0;
    let fullCov = 0;
    let recallSum = 0;
    let f1Sum = 0;
    let unreachable = 0;
    for (const s of scores) {
        if (s.metrics.substringContainment) contain += 1;
        if (s.metrics.fullTokenCoverage) fullCov += 1;
        recallSum += s.metrics.tokenRecall;
        f1Sum += s.metrics.tokenF1;
        if (s.metrics.substringFirstRank < 0) unreachable += 1;
    }
    return {
        count: scores.length,
        substringContainmentRate: contain / scores.length,
        fullTokenCoverageRate: fullCov / scores.length,
        meanTokenRecall: recallSum / scores.length,
        meanTokenF1: f1Sum / scores.length,
        unreachableCount: unreachable,
    };
}
