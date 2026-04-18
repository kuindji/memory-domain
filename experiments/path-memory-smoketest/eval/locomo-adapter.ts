import { PathMemory } from "../src/interfaces.js";
import type { EmbeddingAdapter } from "../../../src/core/types.js";
import type { ClaimId, RetrievalOptions, ScoredPath } from "../src/types.js";
import { turnsToClaims, type LocomoConversation, type LocomoQA } from "../data/locomo-loader.js";
import type { LlmSynthesizer } from "../src/llm-synthesizer.js";

// Phase 7.5 — LOCOMO harness adapter.
//
// Runs the path-memory retriever against a LOCOMO conversation set. Unlike
// LongMemEval, the haystack is per-conversation — every QA pair inside a
// conversation shares the same ingested PathMemory. Each question is used
// as a single retrieval probe.

export type LocomoAdapterOptions = {
    embedder: EmbeddingAdapter;
    retrievalOptions?: RetrievalOptions;
    // Cap on retrieved-claim texts surfaced per question. Defaults to the union
    // of nodeIds across top paths; unbounded if omitted.
    maxClaimsPerQuestion?: number;
    // Optional post-retrieval answer synthesizer. When set, each question's
    // retrieved claim texts are passed to the synthesizer and the result is
    // stored on the question. Phase 8.0.
    synthesizer?: LlmSynthesizer;
};

export type LocomoQuestionResult = {
    sampleId: string;
    questionIndex: number;
    category: string;
    questionText: string;
    goldAnswer: string;
    adversarial: boolean;
    evidenceDiaIds: string[];
    ingestedClaimCount: number;
    topPaths: ScoredPath[];
    retrievedClaimIds: ClaimId[];
    retrievedClaimTexts: string[];
    // Claim ids with the `${sample_id}-` prefix stripped, for evidenceRecall
    // comparison against LOCOMO's dia_id-indexed evidence arrays.
    retrievedDiaIds: string[];
    ingestMs: number;
    retrieveMs: number;
    // Phase 8.0 — only populated when `synthesizer` is provided.
    synthesizedAnswer?: string;
    synthAbstained?: boolean;
    synthMs?: number;
};

export type LocomoConversationResult = {
    sampleId: string;
    ingestMs: number;
    ingestedClaimCount: number;
    skippedTurns: number;
    questions: LocomoQuestionResult[];
};

function collectRetrievedClaims(topPaths: ScoredPath[], maxClaims: number | undefined): ClaimId[] {
    const idOrder: ClaimId[] = [];
    const seen = new Set<ClaimId>();
    for (const sp of topPaths) {
        for (const id of sp.path.nodeIds) {
            if (seen.has(id)) continue;
            seen.add(id);
            idOrder.push(id);
            if (maxClaims !== undefined && idOrder.length >= maxClaims) return idOrder;
        }
    }
    return idOrder;
}

export async function runLocomoConversation(
    conversation: LocomoConversation,
    opts: LocomoAdapterOptions,
): Promise<LocomoConversationResult> {
    const memory = new PathMemory({ embedder: opts.embedder });
    const claims = turnsToClaims(conversation);

    const ingestStart = performance.now();
    await memory.ingestMany(claims);
    const ingestMs = performance.now() - ingestStart;

    const samplePrefix = `${conversation.sampleId}-`;
    const questions: LocomoQuestionResult[] = [];

    for (let qIdx = 0; qIdx < conversation.qa.length; qIdx++) {
        const qa: LocomoQA = conversation.qa[qIdx];
        const retrieveStart = performance.now();
        const topPaths = await memory.queryWithProbes([qa.question], opts.retrievalOptions);
        const retrieveMs = performance.now() - retrieveStart;

        const retrievedClaimIds = collectRetrievedClaims(topPaths, opts.maxClaimsPerQuestion);
        const retrievedClaimTexts: string[] = [];
        const retrievedDiaIds: string[] = [];
        for (const id of retrievedClaimIds) {
            const claim = memory.store.getById(id);
            if (claim) retrievedClaimTexts.push(claim.text);
            retrievedDiaIds.push(id.startsWith(samplePrefix) ? id.slice(samplePrefix.length) : id);
        }

        let synthesizedAnswer: string | undefined;
        let synthAbstained: boolean | undefined;
        let synthMs: number | undefined;
        if (opts.synthesizer !== undefined) {
            const res = await opts.synthesizer.synthesize(qa.question, retrievedClaimTexts);
            synthesizedAnswer = res.answer;
            synthAbstained = res.abstained;
            synthMs = res.ms;
        }

        questions.push({
            sampleId: conversation.sampleId,
            questionIndex: qIdx,
            category: qa.category,
            questionText: qa.question,
            goldAnswer: qa.goldAnswer,
            adversarial: qa.adversarial,
            evidenceDiaIds: qa.evidenceDiaIds,
            ingestedClaimCount: claims.length,
            topPaths,
            retrievedClaimIds,
            retrievedClaimTexts,
            retrievedDiaIds,
            ingestMs: 0, // per-conversation ingestion is shared; recorded on parent
            retrieveMs,
            synthesizedAnswer,
            synthAbstained,
            synthMs,
        });
    }

    return {
        sampleId: conversation.sampleId,
        ingestMs,
        ingestedClaimCount: claims.length,
        skippedTurns: conversation.skippedTurns,
        questions,
    };
}

export async function runLocomo(
    conversations: LocomoConversation[],
    opts: LocomoAdapterOptions,
): Promise<LocomoConversationResult[]> {
    const out: LocomoConversationResult[] = [];
    for (const c of conversations) {
        out.push(await runLocomoConversation(c, opts));
    }
    return out;
}

export function flattenQuestionResults(
    conversationResults: LocomoConversationResult[],
): LocomoQuestionResult[] {
    const out: LocomoQuestionResult[] = [];
    for (const c of conversationResults) {
        for (const q of c.questions) out.push(q);
    }
    return out;
}
