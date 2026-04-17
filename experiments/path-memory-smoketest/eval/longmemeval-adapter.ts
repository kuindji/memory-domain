import { PathMemory } from "../src/interfaces.js";
import type { EmbeddingAdapter } from "../../../src/core/types.js";
import type { ClaimId, RetrievalOptions, ScoredPath } from "../src/types.js";
import {
    turnsToClaims,
    type LongMemEvalQuestion,
    type TurnsToClaimsOptions,
} from "../data/longmemeval-loader.js";

// Phase 7 — LongMemEval harness adapter.
//
// Runs the path-memory retriever against a LongMemEval question set. Each
// question gets a fresh `PathMemory` — LongMemEval's haystack is per-question
// scoped, so there's no cross-question state to preserve. The question text
// itself is used as a single probe (Phase-7 decision; composition is a
// follow-up concern).
//
// Scope boundary: this module does **not** score answers. It returns
// retrieved-claim text per question; downstream scoring (LLM judge or
// rule-based) lives in a follow-up Phase-7 entry.

export type LongMemEvalAdapterOptions = {
    embedder: EmbeddingAdapter;
    retrievalOptions?: RetrievalOptions;
    turnsOptions?: TurnsToClaimsOptions;
    // Cap on retrieved-claim texts surfaced per question. Defaults to the top
    // `resultTopN` paths' union of nodeIds; unbounded if omitted.
    maxClaimsPerQuestion?: number;
};

export type LongMemEvalQuestionResult = {
    questionId: string;
    category: string;
    questionText: string;
    goldAnswer: string;
    ingestedClaimCount: number;
    topPaths: ScoredPath[];
    retrievedClaimIds: ClaimId[];
    retrievedClaimTexts: string[];
    ingestMs: number;
    retrieveMs: number;
};

export async function runLongMemEvalQuestion(
    question: LongMemEvalQuestion,
    opts: LongMemEvalAdapterOptions,
): Promise<LongMemEvalQuestionResult> {
    const memory = new PathMemory({ embedder: opts.embedder });
    const claims = turnsToClaims(question, opts.turnsOptions);

    const ingestStart = performance.now();
    await memory.ingestMany(claims);
    const ingestMs = performance.now() - ingestStart;

    const retrieveStart = performance.now();
    const topPaths = await memory.queryWithProbes([question.questionText], opts.retrievalOptions);
    const retrieveMs = performance.now() - retrieveStart;

    // Deduplicate claim ids while preserving rank order (first occurrence wins).
    const idOrder: ClaimId[] = [];
    const seen = new Set<ClaimId>();
    for (const sp of topPaths) {
        for (const id of sp.path.nodeIds) {
            if (seen.has(id)) continue;
            seen.add(id);
            idOrder.push(id);
            if (
                opts.maxClaimsPerQuestion !== undefined &&
                idOrder.length >= opts.maxClaimsPerQuestion
            ) {
                break;
            }
        }
        if (
            opts.maxClaimsPerQuestion !== undefined &&
            idOrder.length >= opts.maxClaimsPerQuestion
        ) {
            break;
        }
    }

    const texts: string[] = [];
    for (const id of idOrder) {
        const claim = memory.store.getById(id);
        if (claim) texts.push(claim.text);
    }

    return {
        questionId: question.id,
        category: question.category,
        questionText: question.questionText,
        goldAnswer: question.goldAnswer,
        ingestedClaimCount: claims.length,
        topPaths,
        retrievedClaimIds: idOrder,
        retrievedClaimTexts: texts,
        ingestMs,
        retrieveMs,
    };
}

export async function runLongMemEval(
    questions: LongMemEvalQuestion[],
    opts: LongMemEvalAdapterOptions,
): Promise<LongMemEvalQuestionResult[]> {
    const out: LongMemEvalQuestionResult[] = [];
    for (const q of questions) {
        out.push(await runLongMemEvalQuestion(q, opts));
    }
    return out;
}
