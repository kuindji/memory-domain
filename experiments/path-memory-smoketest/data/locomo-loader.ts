import { readFileSync } from "node:fs";
import type { ClaimSpec } from "./tier1-alex.js";

// Phase 7.5 — LOCOMO dataset loader.
//
// Reads a LOCOMO JSON file (upstream: github.com/snap-research/locomo)
// and normalizes each conversation into a typed shape. Unlike LongMemEval,
// LOCOMO's haystack is per-conversation (not per-question) — every QA pair
// inside a conversation shares the same haystack. See `notes/phase-7.5-reading.md`
// for the full schema table and ingestion decisions.

export type LocomoRawTurn = {
    speaker: string;
    dia_id: string;
    text?: string;
    img_url?: string;
    blip_caption?: string;
};

export type LocomoRawQA = {
    question: string;
    // Normal QA has `answer`; adversarial (abstention) QA has `adversarial_answer`
    // in its place. At least one of the two must be present.
    answer?: string;
    adversarial_answer?: string;
    // Upstream LOCOMO-10 ships `category` as an integer label; loader coerces
    // to string for uniform aggregation alongside other datasets.
    category: string | number;
    evidence?: string[];
};

export type LocomoRawConversation = {
    sample_id: string;
    conversation: Record<string, unknown>;
    qa: LocomoRawQA[];
};

export type LocomoTurn = {
    speaker: string;
    diaId: string;
    text: string;
};

export type LocomoSession = {
    sessionIndex: number;
    timestamp: number;
    turns: LocomoTurn[];
};

export type LocomoQA = {
    question: string;
    // Empty string when the entry is adversarial (abstention); otherwise the
    // gold answer coerced to string.
    goldAnswer: string;
    // True when the entry has `adversarial_answer` instead of `answer`.
    // Adversarial questions are LOCOMO's abstention sub-task: the correct
    // retrieval behavior is low-confidence / empty context. Rule-based
    // scoring can't judge abstention, so scorers skip metrics on these.
    adversarial: boolean;
    adversarialAnswer: string;
    category: string;
    evidenceDiaIds: string[];
};

export type LocomoConversation = {
    sampleId: string;
    sessions: LocomoSession[];
    qa: LocomoQA[];
    skippedTurns: number;
};

const LOCOMO_MONTHS: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
};

// LOCOMO-10 ships timestamps like `"1:56 pm on 8 May, 2023"`. `Date.parse`
// doesn't accept this format, so we match it explicitly and fall back to
// `Date.parse` for ISO-style strings (our test fixtures use `YYYY-MM-DD`).
function parseTimestamp(raw: string, where: string): number {
    const trimmed = raw.trim();
    const locomoMatch =
        /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s+(\d{4})$/i.exec(trimmed);
    if (locomoMatch) {
        let hour = Number.parseInt(locomoMatch[1], 10);
        const minute = Number.parseInt(locomoMatch[2], 10);
        const meridiem = locomoMatch[3].toLowerCase();
        const day = Number.parseInt(locomoMatch[4], 10);
        const monthName = locomoMatch[5].toLowerCase();
        const year = Number.parseInt(locomoMatch[6], 10);
        const month = LOCOMO_MONTHS[monthName];
        if (month === undefined) {
            throw new Error(`LOCOMO loader: unknown month "${locomoMatch[5]}" at ${where}`);
        }
        if (meridiem === "pm" && hour < 12) hour += 12;
        if (meridiem === "am" && hour === 12) hour = 0;
        const epochMs = Date.UTC(year, month, day, hour, minute, 0);
        if (Number.isNaN(epochMs)) {
            throw new Error(`LOCOMO loader: invalid date "${raw}" at ${where}`);
        }
        return Math.floor(epochMs / 1000);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
        throw new Error(`LOCOMO loader: invalid date "${raw}" at ${where}`);
    }
    return Math.floor(parsed / 1000);
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function normalizeTurn(raw: unknown, where: string): { turn: LocomoTurn | null; skipped: boolean } {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`LOCOMO loader: ${where} is not an object`);
    }
    const rec = raw as Record<string, unknown>;
    const speaker = asString(rec.speaker);
    const diaId = asString(rec.dia_id);
    if (speaker === undefined) {
        throw new Error(`LOCOMO loader: ${where} missing string speaker`);
    }
    if (diaId === undefined) {
        throw new Error(`LOCOMO loader: ${where} missing string dia_id`);
    }
    const text = asString(rec.text);
    const blip = asString(rec.blip_caption);
    const chosen = text && text.length > 0 ? text : blip && blip.length > 0 ? blip : undefined;
    if (chosen === undefined) {
        return { turn: null, skipped: true };
    }
    return { turn: { speaker, diaId, text: chosen }, skipped: false };
}

function collectSessions(
    conversation: Record<string, unknown>,
    sampleId: string,
): { sessions: LocomoSession[]; skippedTurns: number } {
    const sessionKeys: number[] = [];
    for (const key of Object.keys(conversation)) {
        const match = /^session_(\d+)$/.exec(key);
        if (match) sessionKeys.push(Number.parseInt(match[1], 10));
    }
    sessionKeys.sort((a, b) => a - b);

    const sessions: LocomoSession[] = [];
    let skippedTurns = 0;
    for (const n of sessionKeys) {
        const turnsRaw = conversation[`session_${n}`];
        const dateRaw = conversation[`session_${n}_date_time`];
        if (!Array.isArray(turnsRaw)) {
            throw new Error(`LOCOMO loader: conversation ${sampleId} session_${n} is not an array`);
        }
        if (typeof dateRaw !== "string") {
            throw new Error(
                `LOCOMO loader: conversation ${sampleId} missing string session_${n}_date_time`,
            );
        }
        const baseTimestamp = parseTimestamp(dateRaw, `conversation ${sampleId} session_${n}`);
        const turns: LocomoTurn[] = [];
        for (let t = 0; t < turnsRaw.length; t++) {
            const parsed = normalizeTurn(
                turnsRaw[t],
                `conversation ${sampleId} session_${n} turn ${t}`,
            );
            if (parsed.skipped) {
                skippedTurns += 1;
                continue;
            }
            if (parsed.turn) turns.push(parsed.turn);
        }
        sessions.push({ sessionIndex: n, timestamp: baseTimestamp, turns });
    }
    return { sessions, skippedTurns };
}

function normalizeQA(raw: unknown, where: string): LocomoQA {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`LOCOMO loader: ${where} qa entry is not an object`);
    }
    const rec = raw as Record<string, unknown>;
    const question = asString(rec.question);
    const coerceAnswer = (raw: unknown): string | undefined => {
        if (typeof raw === "string") return raw;
        if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
        return undefined;
    };
    const answer = coerceAnswer(rec.answer);
    const adversarialAnswer = coerceAnswer(rec.adversarial_answer);
    const categoryRaw = rec.category;
    const category =
        typeof categoryRaw === "string"
            ? categoryRaw
            : typeof categoryRaw === "number"
              ? String(categoryRaw)
              : undefined;
    if (question === undefined) {
        throw new Error(`LOCOMO loader: ${where} qa entry missing string question`);
    }
    if (answer === undefined && adversarialAnswer === undefined) {
        throw new Error(
            `LOCOMO loader: ${where} qa entry missing both answer and adversarial_answer`,
        );
    }
    if (category === undefined) {
        throw new Error(`LOCOMO loader: ${where} qa entry missing string/number category`);
    }
    const evidenceRaw = rec.evidence;
    const evidenceDiaIds: string[] = [];
    if (evidenceRaw !== undefined) {
        if (!Array.isArray(evidenceRaw)) {
            throw new Error(`LOCOMO loader: ${where} qa entry evidence is not an array`);
        }
        const evidenceArr = evidenceRaw as unknown[];
        for (let i = 0; i < evidenceArr.length; i++) {
            const entry: unknown = evidenceArr[i];
            if (typeof entry !== "string") {
                throw new Error(`LOCOMO loader: ${where} qa entry evidence[${i}] is not a string`);
            }
            evidenceDiaIds.push(entry);
        }
    }
    const adversarial = answer === undefined;
    return {
        question,
        goldAnswer: answer ?? "",
        adversarial,
        adversarialAnswer: adversarialAnswer ?? "",
        category,
        evidenceDiaIds,
    };
}

function normalizeConversation(raw: unknown, index: number): LocomoConversation {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`LOCOMO loader: conversation #${index} is not an object`);
    }
    const rec = raw as Record<string, unknown>;
    const sampleId = asString(rec.sample_id);
    if (sampleId === undefined) {
        throw new Error(`LOCOMO loader: conversation #${index} missing string sample_id`);
    }
    const conversationRaw = rec.conversation;
    if (typeof conversationRaw !== "object" || conversationRaw === null) {
        throw new Error(`LOCOMO loader: conversation ${sampleId} missing object conversation`);
    }
    const qaRaw = rec.qa;
    if (!Array.isArray(qaRaw)) {
        throw new Error(`LOCOMO loader: conversation ${sampleId} missing qa array`);
    }

    const gathered = collectSessions(conversationRaw as Record<string, unknown>, sampleId);
    const qa: LocomoQA[] = [];
    for (let i = 0; i < qaRaw.length; i++) {
        qa.push(normalizeQA(qaRaw[i], `conversation ${sampleId} qa[${i}]`));
    }

    return {
        sampleId,
        sessions: gathered.sessions,
        qa,
        skippedTurns: gathered.skippedTurns,
    };
}

export function parseLocomo(raw: unknown): LocomoConversation[] {
    if (!Array.isArray(raw)) {
        throw new Error("LOCOMO loader: top-level JSON must be an array of conversations");
    }
    const out: LocomoConversation[] = [];
    for (let i = 0; i < raw.length; i++) {
        out.push(normalizeConversation(raw[i], i));
    }
    return out;
}

export function loadLocomo(path: string): LocomoConversation[] {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parseLocomo(parsed);
}

export function turnsToClaims(conversation: LocomoConversation): ClaimSpec[] {
    const out: ClaimSpec[] = [];
    for (const session of conversation.sessions) {
        for (let t = 0; t < session.turns.length; t++) {
            const turn = session.turns[t];
            out.push({
                id: `${conversation.sampleId}-${turn.diaId}`,
                text: turn.text,
                validFrom: session.timestamp + t,
            });
        }
    }
    return out;
}
