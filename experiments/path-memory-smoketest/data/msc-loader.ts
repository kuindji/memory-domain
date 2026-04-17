import { readFileSync } from "node:fs";
import type { ClaimSpec } from "./tier1-alex.js";

// Phase 7.5 — MSC (Multi-Session Chat) loader.
//
// Upstream: `huggingface.co/datasets/nayohan/multi_session_chat` (parquet).
// Accessed as JSON via HF datasets-server rows endpoint; each row is one
// `(dialoug_id, session_id)` pair. See `notes/phase-7.5-reading.md`.
//
// Note: upstream typo — the id field is `dialoug_id` (not `dialogue_id`).
// We normalize to `dialogueId` in our typed shape.

export type MscRawRow = {
    dataset?: string;
    dialoug_id: number;
    session_id: number;
    persona1: string[];
    persona2: string[];
    dialogue: string[];
    speaker: string[];
};

export type MscSpeaker = "Speaker 1" | "Speaker 2";

export type MscTurn = {
    speaker: MscSpeaker;
    text: string;
};

export type MscSession = {
    sessionId: number;
    persona1: string[];
    persona2: string[];
    turns: MscTurn[];
};

export type MscDialogue = {
    dialogueId: number;
    sessions: MscSession[];
};

function asStringArray(value: unknown, where: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`MSC loader: ${where} is not an array`);
    }
    const out: string[] = [];
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
        const entry: unknown = arr[i];
        if (typeof entry !== "string") {
            throw new Error(`MSC loader: ${where}[${i}] is not a string`);
        }
        out.push(entry);
    }
    return out;
}

function normalizeSpeaker(raw: string, where: string): MscSpeaker {
    if (raw === "Speaker 1" || raw === "Speaker 2") return raw;
    throw new Error(`MSC loader: ${where} has unexpected speaker "${raw}"`);
}

function normalizeRow(raw: unknown, index: number): MscRawRow {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`MSC loader: row #${index} is not an object`);
    }
    const rec = raw as Record<string, unknown>;
    const dialougId = rec.dialoug_id;
    const sessionId = rec.session_id;
    if (typeof dialougId !== "number") {
        throw new Error(`MSC loader: row #${index} missing numeric dialoug_id`);
    }
    if (typeof sessionId !== "number") {
        throw new Error(`MSC loader: row #${index} missing numeric session_id`);
    }
    const persona1 = asStringArray(rec.persona1, `row #${index} persona1`);
    const persona2 = asStringArray(rec.persona2, `row #${index} persona2`);
    const dialogue = asStringArray(rec.dialogue, `row #${index} dialogue`);
    const speaker = asStringArray(rec.speaker, `row #${index} speaker`);
    if (dialogue.length !== speaker.length) {
        throw new Error(
            `MSC loader: row #${index} dialogue/speaker length mismatch (${dialogue.length}/${speaker.length})`,
        );
    }
    return {
        dialoug_id: dialougId,
        session_id: sessionId,
        persona1,
        persona2,
        dialogue,
        speaker,
    };
}

export function parseMscRows(raw: unknown): MscRawRow[] {
    if (!Array.isArray(raw)) {
        throw new Error("MSC loader: top-level JSON must be an array of rows");
    }
    const out: MscRawRow[] = [];
    for (let i = 0; i < raw.length; i++) {
        out.push(normalizeRow(raw[i], i));
    }
    return out;
}

export function groupMscByDialogue(rows: MscRawRow[]): MscDialogue[] {
    const map = new Map<number, MscRawRow[]>();
    for (const row of rows) {
        const list = map.get(row.dialoug_id) ?? [];
        list.push(row);
        map.set(row.dialoug_id, list);
    }
    const out: MscDialogue[] = [];
    const ids = Array.from(map.keys()).sort((a, b) => a - b);
    for (const id of ids) {
        const sessionsRaw = map.get(id);
        if (!sessionsRaw) continue;
        sessionsRaw.sort((a, b) => a.session_id - b.session_id);
        const sessions: MscSession[] = sessionsRaw.map((row) => {
            const turns: MscTurn[] = [];
            for (let i = 0; i < row.dialogue.length; i++) {
                const spk = normalizeSpeaker(
                    row.speaker[i],
                    `dialogue ${id} session ${row.session_id} speaker[${i}]`,
                );
                turns.push({ speaker: spk, text: row.dialogue[i] });
            }
            return {
                sessionId: row.session_id,
                persona1: row.persona1,
                persona2: row.persona2,
                turns,
            };
        });
        out.push({ dialogueId: id, sessions });
    }
    return out;
}

export function loadMsc(path: string): MscDialogue[] {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const rows = parseMscRows(parsed);
    return groupMscByDialogue(rows);
}

// MSC has no real timestamps. We use a fixed per-dialogue base (0) with a
// large per-session offset so intra-session order is preserved and the
// per-session decay in `sessionDecayTau` can separate them. Cross-dialogue
// comparison is meaningless, and our adapter uses fresh `PathMemory` per
// dialogue anyway.
const SESSION_OFFSET = 1_000_000;

export function turnsToClaims(dialogue: MscDialogue): ClaimSpec[] {
    const out: ClaimSpec[] = [];
    for (const session of dialogue.sessions) {
        for (let t = 0; t < session.turns.length; t++) {
            const turn = session.turns[t];
            out.push({
                id: `${dialogue.dialogueId}-s${session.sessionId}-t${t}`,
                text: turn.text,
                validFrom: session.sessionId * SESSION_OFFSET + t,
            });
        }
    }
    return out;
}

export function finalSessionPersonas(dialogue: MscDialogue): {
    persona1: string[];
    persona2: string[];
} {
    if (dialogue.sessions.length === 0) return { persona1: [], persona2: [] };
    const last = dialogue.sessions[dialogue.sessions.length - 1];
    return { persona1: last.persona1, persona2: last.persona2 };
}
