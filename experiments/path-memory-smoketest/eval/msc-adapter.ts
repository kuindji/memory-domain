import { PathMemory } from "../src/interfaces.js";
import type { EmbeddingAdapter } from "../../../src/core/types.js";
import type { ClaimId, RetrievalOptions, ScoredPath } from "../src/types.js";
import { finalSessionPersonas, turnsToClaims, type MscDialogue } from "../data/msc-loader.js";

// Phase 7.5 — MSC persona-recall adapter.
//
// MSC has no built-in QA; we repurpose the final-session persona lists as
// gold facts and issue two retrieval probes per dialogue. See
// `notes/phase-7.5-reading.md` for the probe-design rationale and honest
// limitations.

export type MscProbes = {
    speaker1: string;
    speaker2: string;
};

export const DEFAULT_MSC_PROBES: MscProbes = {
    speaker1: "What do we know about Speaker 1?",
    speaker2: "What do we know about Speaker 2?",
};

export type MscAdapterOptions = {
    embedder: EmbeddingAdapter;
    retrievalOptions?: RetrievalOptions;
    probes?: MscProbes;
    maxClaimsPerProbe?: number;
};

export type MscProbeResult = {
    speaker: "Speaker 1" | "Speaker 2";
    probeText: string;
    goldPersona: string[];
    topPaths: ScoredPath[];
    retrievedClaimIds: ClaimId[];
    retrievedClaimTexts: string[];
    retrieveMs: number;
};

export type MscDialogueResult = {
    dialogueId: number;
    ingestedClaimCount: number;
    sessionCount: number;
    ingestMs: number;
    speaker1: MscProbeResult;
    speaker2: MscProbeResult;
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

async function runProbe(
    memory: PathMemory,
    speaker: "Speaker 1" | "Speaker 2",
    probeText: string,
    goldPersona: string[],
    retrievalOptions: RetrievalOptions | undefined,
    maxClaimsPerProbe: number | undefined,
): Promise<MscProbeResult> {
    const retrieveStart = performance.now();
    const topPaths = await memory.queryWithProbes([probeText], retrievalOptions);
    const retrieveMs = performance.now() - retrieveStart;

    const retrievedClaimIds = collectRetrievedClaims(topPaths, maxClaimsPerProbe);
    const retrievedClaimTexts: string[] = [];
    for (const id of retrievedClaimIds) {
        const claim = memory.store.getById(id);
        if (claim) retrievedClaimTexts.push(claim.text);
    }

    return {
        speaker,
        probeText,
        goldPersona,
        topPaths,
        retrievedClaimIds,
        retrievedClaimTexts,
        retrieveMs,
    };
}

export async function runMscDialogue(
    dialogue: MscDialogue,
    opts: MscAdapterOptions,
): Promise<MscDialogueResult> {
    const memory = new PathMemory({ embedder: opts.embedder });
    const claims = turnsToClaims(dialogue);

    const ingestStart = performance.now();
    await memory.ingestMany(claims);
    const ingestMs = performance.now() - ingestStart;

    const probes = opts.probes ?? DEFAULT_MSC_PROBES;
    const { persona1, persona2 } = finalSessionPersonas(dialogue);

    const speaker1 = await runProbe(
        memory,
        "Speaker 1",
        probes.speaker1,
        persona1,
        opts.retrievalOptions,
        opts.maxClaimsPerProbe,
    );
    const speaker2 = await runProbe(
        memory,
        "Speaker 2",
        probes.speaker2,
        persona2,
        opts.retrievalOptions,
        opts.maxClaimsPerProbe,
    );

    return {
        dialogueId: dialogue.dialogueId,
        ingestedClaimCount: claims.length,
        sessionCount: dialogue.sessions.length,
        ingestMs,
        speaker1,
        speaker2,
    };
}

export async function runMsc(
    dialogues: MscDialogue[],
    opts: MscAdapterOptions,
): Promise<MscDialogueResult[]> {
    const out: MscDialogueResult[] = [];
    for (const d of dialogues) {
        out.push(await runMscDialogue(d, opts));
    }
    return out;
}
