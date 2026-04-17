import { tokenize } from "../src/tokenize.js";
import type { MscDialogueResult, MscProbeResult } from "./msc-adapter.js";

// Phase 7.5 — MSC persona-recall scorer.
//
// Non-standard use of MSC (it has no QA). For each dialogue we retrieved
// context for two persona-recall probes; this scores how well the retrieved
// context surfaces the final-session persona facts. Rule-based only.
// Treat as corpus-shape diagnostic, not a leaderboard metric.

export type MscProbeMetrics = {
    // Fraction of stopword-filtered gold persona tokens present in the
    // retrieved context. Concatenates the persona list into a single string
    // before tokenization.
    personaTokenRecall: number;
    // Fraction of individual persona strings whose verbatim (case-folded)
    // text appears somewhere in the retrieved context. Weaker but precise.
    personaStringContainmentRate: number;
    goldTokenCount: number;
    contextTokenCount: number;
    personaCount: number;
    personaContainmentHits: number;
};

export type MscDialogueScore = {
    dialogueId: number;
    speaker1: MscProbeMetrics;
    speaker2: MscProbeMetrics;
};

function buildContextString(probe: MscProbeResult): string {
    return probe.retrievedClaimTexts.join(" \n ");
}

function scoreProbe(probe: MscProbeResult): MscProbeMetrics {
    const goldJoined = probe.goldPersona.join(" ");
    const goldTokens = tokenize(goldJoined);
    const context = buildContextString(probe);
    const contextTokens = tokenize(context);
    const contextTokenSet = new Set(contextTokens);

    let tokenHits = 0;
    for (const t of goldTokens) if (contextTokenSet.has(t)) tokenHits += 1;
    const personaTokenRecall = goldTokens.length > 0 ? tokenHits / goldTokens.length : 0;

    const contextLower = context.toLowerCase();
    let personaContainmentHits = 0;
    for (const p of probe.goldPersona) {
        const lower = p.toLowerCase().trim();
        if (lower.length > 0 && contextLower.includes(lower)) personaContainmentHits += 1;
    }
    const personaStringContainmentRate =
        probe.goldPersona.length > 0 ? personaContainmentHits / probe.goldPersona.length : 0;

    return {
        personaTokenRecall,
        personaStringContainmentRate,
        goldTokenCount: goldTokens.length,
        contextTokenCount: contextTokens.length,
        personaCount: probe.goldPersona.length,
        personaContainmentHits,
    };
}

export function scoreMscDialogue(result: MscDialogueResult): MscDialogueScore {
    return {
        dialogueId: result.dialogueId,
        speaker1: scoreProbe(result.speaker1),
        speaker2: scoreProbe(result.speaker2),
    };
}

export function scoreMsc(results: MscDialogueResult[]): MscDialogueScore[] {
    return results.map(scoreMscDialogue);
}

export type MscAggregate = {
    speakerKey: "speaker1" | "speaker2" | "combined";
    dialogueCount: number;
    probeCount: number;
    meanPersonaTokenRecall: number;
    medianPersonaTokenRecall: number;
    fractionAbove80: number;
    meanPersonaStringContainmentRate: number;
};

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
    return sorted[mid];
}

function aggregateProbes(
    probes: MscProbeMetrics[],
    key: "speaker1" | "speaker2" | "combined",
    dialogueCount: number,
): MscAggregate {
    if (probes.length === 0) {
        return {
            speakerKey: key,
            dialogueCount,
            probeCount: 0,
            meanPersonaTokenRecall: 0,
            medianPersonaTokenRecall: 0,
            fractionAbove80: 0,
            meanPersonaStringContainmentRate: 0,
        };
    }
    const recalls = probes.map((p) => p.personaTokenRecall);
    const containments = probes.map((p) => p.personaStringContainmentRate);
    const meanRecall = recalls.reduce((a, b) => a + b, 0) / recalls.length;
    const above80 = recalls.filter((r) => r >= 0.8).length / recalls.length;
    const meanContainment = containments.reduce((a, b) => a + b, 0) / containments.length;
    return {
        speakerKey: key,
        dialogueCount,
        probeCount: probes.length,
        meanPersonaTokenRecall: meanRecall,
        medianPersonaTokenRecall: median(recalls),
        fractionAbove80: above80,
        meanPersonaStringContainmentRate: meanContainment,
    };
}

export function aggregateMsc(scores: MscDialogueScore[]): {
    speaker1: MscAggregate;
    speaker2: MscAggregate;
    combined: MscAggregate;
} {
    const s1 = scores.map((s) => s.speaker1);
    const s2 = scores.map((s) => s.speaker2);
    return {
        speaker1: aggregateProbes(s1, "speaker1", scores.length),
        speaker2: aggregateProbes(s2, "speaker2", scores.length),
        combined: aggregateProbes([...s1, ...s2], "combined", scores.length),
    };
}
