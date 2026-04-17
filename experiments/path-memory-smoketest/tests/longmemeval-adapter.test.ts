import { describe, test, expect } from "bun:test";
import {
    parseLongMemEval,
    turnsToClaims,
    type LongMemEvalRawQuestion,
} from "../data/longmemeval-loader.js";
import { runLongMemEval, runLongMemEvalQuestion } from "../eval/longmemeval-adapter.js";
import { makeFakeEmbedder } from "./helpers.js";

// Phase 7 — synthetic LongMemEval fixture (no external dataset).
// Three questions, two categories; each session carries 2–3 turns.

const FIXTURE: LongMemEvalRawQuestion[] = [
    {
        question_id: "q_alpha",
        question_type: "single-session-user",
        question: "Where did Alex say he grew up?",
        answer: "Boston",
        haystack_sessions: [
            [
                { role: "user", content: "Hey, I grew up in Boston Massachusetts." },
                { role: "assistant", content: "Boston is a great city. Any favorite spots?" },
                { role: "user", content: "I loved the Common and the waterfront." },
            ],
        ],
        haystack_session_ids: ["s1"],
        haystack_dates: ["2024-05-20"],
        answer_session_ids: ["s1"],
    },
    {
        question_id: "q_beta",
        question_type: "temporal-reasoning",
        question: "When did Alex move to Cambridge?",
        answer: "During college",
        haystack_sessions: [
            [
                { role: "user", content: "I grew up in Boston." },
                { role: "assistant", content: "Nice." },
            ],
            [
                { role: "user", content: "I moved to Cambridge when I started college at MIT." },
                { role: "assistant", content: "How did that go?" },
                { role: "user", content: "Commute was easier than Boston." },
            ],
        ],
        haystack_session_ids: ["s1", "s2"],
        haystack_dates: ["2024-05-20", "2024-09-15"],
        answer_session_ids: ["s2"],
    },
    {
        question_id: "q_gamma",
        question_type: "multi-session",
        question: "What hobby did Alex pick up at MIT?",
        answer: "Hiking",
        haystack_sessions: [
            [
                { role: "user", content: "Started at MIT last week for computer science." },
                { role: "assistant", content: "Good luck with the workload." },
            ],
            [
                { role: "user", content: "I took up hiking on weekends to decompress." },
                { role: "assistant", content: "That sounds healthy." },
            ],
        ],
        haystack_session_ids: ["s1", "s2"],
        haystack_dates: ["2024-09-01", "2024-10-10"],
        answer_session_ids: ["s2"],
    },
];

describe("LongMemEval loader", () => {
    test("parseLongMemEval normalizes raw JSON and preserves all fields", () => {
        const questions = parseLongMemEval(FIXTURE);
        expect(questions).toHaveLength(3);

        const q0 = questions[0];
        expect(q0.id).toBe("q_alpha");
        expect(q0.category).toBe("single-session-user");
        expect(q0.questionText).toBe("Where did Alex say he grew up?");
        expect(q0.goldAnswer).toBe("Boston");
        expect(q0.sessions).toHaveLength(1);
        expect(q0.sessions[0].sessionId).toBe("s1");
        expect(q0.sessions[0].turns).toHaveLength(3);
        expect(q0.sessions[0].turns[0]).toEqual({
            role: "user",
            content: "Hey, I grew up in Boston Massachusetts.",
        });
        expect(q0.answerSessionIds).toEqual(["s1"]);
    });

    test("parseLongMemEval parses dates to monotonic epoch seconds", () => {
        const questions = parseLongMemEval(FIXTURE);
        const q1 = questions[1];
        expect(q1.sessions).toHaveLength(2);
        expect(q1.sessions[0].timestamp).toBeLessThan(q1.sessions[1].timestamp);
        // 2024-05-20 UTC = 1716163200
        expect(q1.sessions[0].timestamp).toBe(Math.floor(Date.parse("2024-05-20") / 1000));
    });

    test("parseLongMemEval throws on missing required fields", () => {
        const bad = [{ question_id: "missing_fields" }];
        expect(() => parseLongMemEval(bad)).toThrow(/question_type/);
    });

    test("parseLongMemEval throws on session arity mismatch", () => {
        const mismatched = [
            {
                ...FIXTURE[0],
                haystack_session_ids: ["s1", "s2"],
            },
        ];
        expect(() => parseLongMemEval(mismatched)).toThrow(/arity mismatch/);
    });

    test("parseLongMemEval rejects turn roles outside user|assistant", () => {
        const badRole = [
            {
                ...FIXTURE[0],
                haystack_sessions: [[{ role: "system", content: "x" }]],
            },
        ];
        expect(() => parseLongMemEval(badRole)).toThrow(/role/);
    });
});

describe("turnsToClaims", () => {
    test("produces deterministic ids and monotonic validFrom", () => {
        const q = parseLongMemEval(FIXTURE)[1];
        const a = turnsToClaims(q);
        const b = turnsToClaims(q);
        expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));

        expect(a[0].id).toBe("q_beta-s0-t0");
        expect(a[1].id).toBe("q_beta-s0-t1");
        expect(a[2].id).toBe("q_beta-s1-t0");

        for (let i = 1; i < a.length; i++) {
            expect(a[i].validFrom).toBeGreaterThan(a[i - 1].validFrom);
        }
    });

    test("includeAssistantTurns=false filters assistant turns", () => {
        const q = parseLongMemEval(FIXTURE)[0];
        const withAssistant = turnsToClaims(q);
        const userOnly = turnsToClaims(q, { includeAssistantTurns: false });
        expect(userOnly.length).toBeLessThan(withAssistant.length);
        for (const claim of userOnly) {
            expect(claim.text.toLowerCase()).not.toContain("boston is a great city");
        }
    });
});

describe("runLongMemEval adapter", () => {
    test("returns one result per question with retrieved claim texts", async () => {
        const embedder = makeFakeEmbedder();
        const questions = parseLongMemEval(FIXTURE);
        const results = await runLongMemEval(questions, {
            embedder,
            retrievalOptions: { anchorTopK: 3, resultTopN: 5 },
        });

        expect(results).toHaveLength(questions.length);
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            expect(r.questionId).toBe(questions[i].id);
            expect(r.category).toBe(questions[i].category);
            expect(r.ingestedClaimCount).toBeGreaterThan(0);
            expect(r.topPaths.length).toBeGreaterThan(0);
            expect(r.retrievedClaimIds.length).toBeGreaterThan(0);
            expect(r.retrievedClaimTexts.length).toBe(r.retrievedClaimIds.length);
            expect(r.ingestMs).toBeGreaterThanOrEqual(0);
            expect(r.retrieveMs).toBeGreaterThanOrEqual(0);
        }
    });

    test("maxClaimsPerQuestion caps retrieved claim output", async () => {
        const embedder = makeFakeEmbedder();
        const question = parseLongMemEval(FIXTURE)[0];
        const capped = await runLongMemEvalQuestion(question, {
            embedder,
            retrievalOptions: { anchorTopK: 3, resultTopN: 5 },
            maxClaimsPerQuestion: 2,
        });
        expect(capped.retrievedClaimIds.length).toBeLessThanOrEqual(2);
    });

    test("idempotent ingestion — running the same question twice produces identical claim ids", async () => {
        const embedder = makeFakeEmbedder();
        const question = parseLongMemEval(FIXTURE)[0];
        const first = await runLongMemEvalQuestion(question, { embedder });
        const second = await runLongMemEvalQuestion(question, { embedder });
        // Per-question fresh PathMemory: same deterministic ids appear on both runs.
        expect(first.retrievedClaimIds).toEqual(second.retrievedClaimIds);
    });
});
