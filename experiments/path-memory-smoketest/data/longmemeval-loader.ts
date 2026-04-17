import { readFileSync } from "node:fs";
import type { ClaimSpec } from "./tier1-alex.js";

// Phase 7 — LongMemEval dataset loader.
//
// Reads a LongMemEval JSON file (LongMemEval-S by default) and normalizes it
// into a typed, retriever-ready shape. The raw benchmark ships each question
// as one object with a flat array of conversation sessions in
// `haystack_sessions`, per-session dates in `haystack_dates`, and the
// evaluation question + gold answer at the top level. Exact field names
// follow the upstream release; see `notes/phase-7-reading.md`.
//
// The dataset itself is not checked into this repo (size + license).
// Place the JSON file at `data/longmemeval-s.json` manually; the loader is
// strict about missing fields so any schema drift will fail loudly.

export type LongMemEvalTurnRole = "user" | "assistant";

export type LongMemEvalRawTurn = {
    role: LongMemEvalTurnRole;
    content: string;
};

export type LongMemEvalRawQuestion = {
    question_id: string;
    question_type: string;
    question: string;
    answer: string;
    haystack_sessions: LongMemEvalRawTurn[][];
    haystack_session_ids: string[];
    haystack_dates: string[];
    answer_session_ids?: string[];
};

export type LongMemEvalTurn = {
    role: LongMemEvalTurnRole;
    content: string;
};

export type LongMemEvalSession = {
    sessionId: string;
    timestamp: number;
    turns: LongMemEvalTurn[];
};

export type LongMemEvalQuestion = {
    id: string;
    category: string;
    questionText: string;
    goldAnswer: string;
    sessions: LongMemEvalSession[];
    answerSessionIds: string[];
};

function parseTimestamp(raw: string, where: string): number {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) {
        throw new Error(`LongMemEval loader: invalid date "${raw}" at ${where}`);
    }
    return Math.floor(parsed / 1000);
}

function assertTurnShape(turn: unknown, where: string): LongMemEvalRawTurn {
    if (typeof turn !== "object" || turn === null) {
        throw new Error(`LongMemEval loader: ${where} is not an object`);
    }
    const candidate = turn as Record<string, unknown>;
    const role = candidate.role;
    const content = candidate.content;
    if (role !== "user" && role !== "assistant") {
        throw new Error(
            `LongMemEval loader: ${where}.role is "${String(role)}" (expected "user" or "assistant")`,
        );
    }
    if (typeof content !== "string") {
        throw new Error(`LongMemEval loader: ${where}.content is not a string`);
    }
    return { role, content };
}

function normalizeQuestion(raw: unknown, index: number): LongMemEvalQuestion {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`LongMemEval loader: question #${index} is not an object`);
    }
    const rec = raw as Record<string, unknown>;

    const questionId = rec.question_id;
    const questionType = rec.question_type;
    const questionText = rec.question;
    const goldAnswer = rec.answer;
    const sessions = rec.haystack_sessions;
    const sessionIds = rec.haystack_session_ids;
    const dates = rec.haystack_dates;
    const answerSessionIds = rec.answer_session_ids;

    if (typeof questionId !== "string") {
        throw new Error(`LongMemEval loader: question #${index} missing string question_id`);
    }
    if (typeof questionType !== "string") {
        throw new Error(`LongMemEval loader: question ${questionId} missing string question_type`);
    }
    if (typeof questionText !== "string") {
        throw new Error(`LongMemEval loader: question ${questionId} missing string question`);
    }
    if (typeof goldAnswer !== "string") {
        throw new Error(`LongMemEval loader: question ${questionId} missing string answer`);
    }
    if (!Array.isArray(sessions)) {
        throw new Error(
            `LongMemEval loader: question ${questionId} missing haystack_sessions array`,
        );
    }
    if (!Array.isArray(sessionIds)) {
        throw new Error(
            `LongMemEval loader: question ${questionId} missing haystack_session_ids array`,
        );
    }
    if (!Array.isArray(dates)) {
        throw new Error(`LongMemEval loader: question ${questionId} missing haystack_dates array`);
    }
    const sessionsArr = sessions as unknown[];
    const sessionIdsArr = sessionIds as unknown[];
    const datesArr = dates as unknown[];
    if (sessionsArr.length !== sessionIdsArr.length || sessionsArr.length !== datesArr.length) {
        throw new Error(
            `LongMemEval loader: question ${questionId} session-arity mismatch sessions=${sessionsArr.length} ids=${sessionIdsArr.length} dates=${datesArr.length}`,
        );
    }
    const normalizedAnswerIds: string[] = [];
    if (answerSessionIds !== undefined) {
        if (!Array.isArray(answerSessionIds)) {
            throw new Error(
                `LongMemEval loader: question ${questionId} answer_session_ids is not an array`,
            );
        }
        const answerIdsArr = answerSessionIds as unknown[];
        for (let i = 0; i < answerIdsArr.length; i++) {
            const entry = answerIdsArr[i];
            if (typeof entry !== "string") {
                throw new Error(
                    `LongMemEval loader: question ${questionId} answer_session_ids[${i}] is not a string`,
                );
            }
            normalizedAnswerIds.push(entry);
        }
    }

    const normSessions: LongMemEvalSession[] = [];
    for (let s = 0; s < sessionsArr.length; s++) {
        const rawTurns: unknown = sessionsArr[s];
        const rawId: unknown = sessionIdsArr[s];
        const rawDate: unknown = datesArr[s];
        if (!Array.isArray(rawTurns)) {
            throw new Error(
                `LongMemEval loader: question ${questionId} session ${s} turns are not an array`,
            );
        }
        if (typeof rawId !== "string") {
            throw new Error(
                `LongMemEval loader: question ${questionId} session ${s} id is not a string`,
            );
        }
        if (typeof rawDate !== "string") {
            throw new Error(
                `LongMemEval loader: question ${questionId} session ${s} date is not a string`,
            );
        }
        const timestamp = parseTimestamp(rawDate, `question ${questionId} session ${s}`);
        const rawTurnsArr = rawTurns as unknown[];
        const turns: LongMemEvalTurn[] = [];
        for (let t = 0; t < rawTurnsArr.length; t++) {
            turns.push(
                assertTurnShape(rawTurnsArr[t], `question ${questionId} session ${s} turn ${t}`),
            );
        }
        normSessions.push({ sessionId: rawId, timestamp, turns });
    }

    return {
        id: questionId,
        category: questionType,
        questionText,
        goldAnswer,
        sessions: normSessions,
        answerSessionIds: normalizedAnswerIds,
    };
}

export function parseLongMemEval(raw: unknown): LongMemEvalQuestion[] {
    if (!Array.isArray(raw)) {
        throw new Error("LongMemEval loader: top-level JSON must be an array of questions");
    }
    const out: LongMemEvalQuestion[] = [];
    for (let i = 0; i < raw.length; i++) {
        out.push(normalizeQuestion(raw[i], i));
    }
    return out;
}

export function loadLongMemEval(path: string): LongMemEvalQuestion[] {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parseLongMemEval(parsed);
}

export type TurnsToClaimsOptions = {
    // If true (default), both user and assistant turns are ingested. If false,
    // only user turns are ingested (assistant text is discarded). Default mirrors
    // Memento/Zep's baseline approach of indexing both sides of the conversation.
    includeAssistantTurns?: boolean;
};

export function turnsToClaims(
    question: LongMemEvalQuestion,
    options: TurnsToClaimsOptions = {},
): ClaimSpec[] {
    const includeAssistant = options.includeAssistantTurns ?? true;
    const out: ClaimSpec[] = [];
    for (let s = 0; s < question.sessions.length; s++) {
        const session = question.sessions[s];
        for (let t = 0; t < session.turns.length; t++) {
            const turn = session.turns[t];
            if (!includeAssistant && turn.role === "assistant") continue;
            const id = `${question.id}-s${s}-t${t}`;
            // Day-granular timestamps; add turn index so intra-session order is
            // preserved as monotonic validFrom (1-second offsets — opaque to
            // LongMemEval questions, which reason at day granularity at best).
            const validFrom = session.timestamp + t;
            out.push({
                id,
                text: turn.content,
                validFrom,
            });
        }
    }
    return out;
}
