import { tokenize } from "../src/tokenize.js";
import type { LocomoQuestionResult } from "./locomo-adapter.js";

// Phase 7.5 — rule-based LOCOMO scoring.
//
// Extends the LongMemEval metric bundle with `evidenceRecall`: LOCOMO ships
// gold dia_ids per question, so we can score retrieval directly against the
// evidence set (a capability LongMemEval lacks).
//
// Same caveats as LongMemEval rule-based scoring: numbers are
// internally-comparable across path-memory configs, not apples-to-apples
// against peer systems that use GPT-4o-as-judge.

export type LocomoMetricBundle = {
    // Substring and token metrics — identical to LongMemEval's bundle.
    substringContainment: boolean;
    substringFirstRank: number;
    tokenRecall: number;
    tokenF1: number;
    fullTokenCoverage: boolean;
    goldTokenCount: number;
    contextTokenCount: number;

    // LOCOMO-specific: fraction of gold evidence dia_ids whose corresponding
    // claim appears in the retrieved set. Null when gold evidence is absent.
    evidenceRecall: number | null;
    evidenceHits: number;
    evidenceTotal: number;
};

export type LocomoScore = {
    sampleId: string;
    questionIndex: number;
    category: string;
    adversarial: boolean;
    metrics: LocomoMetricBundle;
};

function buildContextString(result: LocomoQuestionResult): string {
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

function scoreMetrics(result: LocomoQuestionResult): LocomoMetricBundle {
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
    if (goldTokens.length > 0) {
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

    let evidenceRecall: number | null = null;
    let evidenceHits = 0;
    const evidenceTotal = result.evidenceDiaIds.length;
    if (evidenceTotal > 0) {
        const retrievedSet = new Set(result.retrievedDiaIds);
        for (const dia of result.evidenceDiaIds) {
            if (retrievedSet.has(dia)) evidenceHits += 1;
        }
        evidenceRecall = evidenceHits / evidenceTotal;
    }

    return {
        substringContainment,
        substringFirstRank,
        tokenRecall,
        tokenF1,
        fullTokenCoverage,
        goldTokenCount: goldTokens.length,
        contextTokenCount: contextTokens.length,
        evidenceRecall,
        evidenceHits,
        evidenceTotal,
    };
}

export function scoreLocomoResult(result: LocomoQuestionResult): LocomoScore {
    return {
        sampleId: result.sampleId,
        questionIndex: result.questionIndex,
        category: result.category,
        adversarial: result.adversarial,
        metrics: scoreMetrics(result),
    };
}

export function scoreLocomo(results: LocomoQuestionResult[]): LocomoScore[] {
    return results.map((r) => scoreLocomoResult(r));
}

export type LocomoCategoryAggregate = {
    category: string;
    count: number;
    // Number of adversarial (abstention) entries in this category. Excluded
    // from the rate/recall metrics below — rule-based scoring can't judge
    // abstention; reported for diagnostics only.
    adversarialCount: number;
    // Number of non-adversarial entries backing the rate/recall metrics.
    scoredCount: number;
    substringContainmentRate: number;
    fullTokenCoverageRate: number;
    meanTokenRecall: number;
    meanTokenF1: number;
    meanSubstringFirstRank: number;
    unreachableCount: number;
    evidenceCount: number;
    meanEvidenceRecall: number;
};

export function aggregateLocomoByCategory(scores: LocomoScore[]): LocomoCategoryAggregate[] {
    const buckets = new Map<string, LocomoScore[]>();
    for (const s of scores) {
        const list = buckets.get(s.category) ?? [];
        list.push(s);
        buckets.set(s.category, list);
    }

    const out: LocomoCategoryAggregate[] = [];
    const categories = Array.from(buckets.keys()).sort();
    for (const category of categories) {
        const entries = buckets.get(category);
        if (!entries || entries.length === 0) continue;
        const n = entries.length;
        let adversarialCount = 0;
        let containHits = 0;
        let fullCoverageHits = 0;
        let recallSum = 0;
        let f1Sum = 0;
        let rankSum = 0;
        let rankHits = 0;
        let unreachable = 0;
        let evidenceCount = 0;
        let evidenceRecallSum = 0;
        for (const s of entries) {
            if (s.adversarial) {
                adversarialCount += 1;
                continue;
            }
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
            if (s.metrics.evidenceRecall !== null) {
                evidenceCount += 1;
                evidenceRecallSum += s.metrics.evidenceRecall;
            }
        }
        const scoredCount = n - adversarialCount;
        out.push({
            category,
            count: n,
            adversarialCount,
            scoredCount,
            substringContainmentRate: scoredCount > 0 ? containHits / scoredCount : 0,
            fullTokenCoverageRate: scoredCount > 0 ? fullCoverageHits / scoredCount : 0,
            meanTokenRecall: scoredCount > 0 ? recallSum / scoredCount : 0,
            meanTokenF1: scoredCount > 0 ? f1Sum / scoredCount : 0,
            meanSubstringFirstRank: rankHits > 0 ? rankSum / rankHits : -1,
            unreachableCount: unreachable,
            evidenceCount,
            meanEvidenceRecall: evidenceCount > 0 ? evidenceRecallSum / evidenceCount : 0,
        });
    }
    return out;
}

export type LocomoOverallAggregate = {
    count: number;
    adversarialCount: number;
    scoredCount: number;
    substringContainmentRate: number;
    fullTokenCoverageRate: number;
    meanTokenRecall: number;
    meanTokenF1: number;
    unreachableCount: number;
    evidenceCount: number;
    meanEvidenceRecall: number;
};

export function aggregateLocomoOverall(scores: LocomoScore[]): LocomoOverallAggregate {
    if (scores.length === 0) {
        return {
            count: 0,
            adversarialCount: 0,
            scoredCount: 0,
            substringContainmentRate: 0,
            fullTokenCoverageRate: 0,
            meanTokenRecall: 0,
            meanTokenF1: 0,
            unreachableCount: 0,
            evidenceCount: 0,
            meanEvidenceRecall: 0,
        };
    }
    let adversarialCount = 0;
    let contain = 0;
    let fullCov = 0;
    let recallSum = 0;
    let f1Sum = 0;
    let unreachable = 0;
    let evidenceCount = 0;
    let evidenceRecallSum = 0;
    for (const s of scores) {
        if (s.adversarial) {
            adversarialCount += 1;
            continue;
        }
        if (s.metrics.substringContainment) contain += 1;
        if (s.metrics.fullTokenCoverage) fullCov += 1;
        recallSum += s.metrics.tokenRecall;
        f1Sum += s.metrics.tokenF1;
        if (s.metrics.substringFirstRank < 0) unreachable += 1;
        if (s.metrics.evidenceRecall !== null) {
            evidenceCount += 1;
            evidenceRecallSum += s.metrics.evidenceRecall;
        }
    }
    const scoredCount = scores.length - adversarialCount;
    return {
        count: scores.length,
        adversarialCount,
        scoredCount,
        substringContainmentRate: scoredCount > 0 ? contain / scoredCount : 0,
        fullTokenCoverageRate: scoredCount > 0 ? fullCov / scoredCount : 0,
        meanTokenRecall: scoredCount > 0 ? recallSum / scoredCount : 0,
        meanTokenF1: scoredCount > 0 ? f1Sum / scoredCount : 0,
        unreachableCount: unreachable,
        evidenceCount,
        meanEvidenceRecall: evidenceCount > 0 ? evidenceRecallSum / evidenceCount : 0,
    };
}
