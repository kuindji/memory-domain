import { describe, test, expect } from "bun:test";
import { parseLocomo, turnsToClaims } from "../data/locomo-loader.js";

// Phase 7.5 — LOCOMO loader smoke tests. Inline fixture mirrors the
// upstream snap-research/locomo schema.

const FIXTURE = [
    {
        sample_id: "conv_alpha",
        conversation: {
            session_1: [
                { speaker: "A", dia_id: "D1:1", text: "I just moved to Portland last week." },
                { speaker: "B", dia_id: "D1:2", text: "How are you liking it so far?" },
                { speaker: "A", dia_id: "D1:3", text: "Rainy but the coffee is amazing." },
            ],
            session_1_date_time: "2024-03-01 10:00:00",
            session_2: [
                { speaker: "A", dia_id: "D2:1", text: "Joined a hiking group on the weekend." },
                {
                    speaker: "B",
                    dia_id: "D2:2",
                    text: "That sounds like a great way to meet people.",
                },
            ],
            session_2_date_time: "2024-03-08 14:30:00",
            session_3: [
                {
                    speaker: "A",
                    dia_id: "D3:1",
                    img_url: "https://example.com/img.jpg",
                    blip_caption: "a picture of a mountain trail",
                },
                {
                    speaker: "A",
                    dia_id: "D3:2",
                    img_url: "https://example.com/img2.jpg",
                },
                { speaker: "B", dia_id: "D3:3", text: "Nice scenery!" },
            ],
            session_3_date_time: "2024-03-15 09:00:00",
        },
        qa: [
            {
                question: "Where did A move to?",
                answer: "Portland",
                category: "single-hop",
                evidence: ["D1:1"],
            },
            {
                question: "What activity did A pick up?",
                answer: "Hiking",
                category: "multi-hop",
                evidence: ["D2:1"],
            },
        ],
    },
];

describe("LOCOMO loader", () => {
    test("parseLocomo normalizes sessions and qa", () => {
        const convs = parseLocomo(FIXTURE);
        expect(convs).toHaveLength(1);
        const c = convs[0];
        expect(c.sampleId).toBe("conv_alpha");
        expect(c.sessions).toHaveLength(3);
        expect(c.sessions[0].sessionIndex).toBe(1);
        expect(c.sessions[0].turns).toHaveLength(3);
        expect(c.sessions[0].turns[0].diaId).toBe("D1:1");
        expect(c.sessions[0].turns[0].text).toBe("I just moved to Portland last week.");
        expect(c.qa).toHaveLength(2);
        expect(c.qa[0].question).toBe("Where did A move to?");
        expect(c.qa[0].goldAnswer).toBe("Portland");
        expect(c.qa[0].category).toBe("single-hop");
        expect(c.qa[0].evidenceDiaIds).toEqual(["D1:1"]);
    });

    test("session timestamps are monotonic across sessions", () => {
        const c = parseLocomo(FIXTURE)[0];
        expect(c.sessions[0].timestamp).toBeLessThan(c.sessions[1].timestamp);
        expect(c.sessions[1].timestamp).toBeLessThan(c.sessions[2].timestamp);
    });

    test("image-only turns without text fall back to blip_caption; no-caption turns are skipped", () => {
        const c = parseLocomo(FIXTURE)[0];
        // session_3 has 3 raw turns: one with blip_caption, one image-only (no caption), one text.
        expect(c.sessions[2].turns).toHaveLength(2);
        expect(c.sessions[2].turns[0].text).toBe("a picture of a mountain trail");
        expect(c.skippedTurns).toBe(1);
    });

    test("parseLocomo throws on missing sample_id", () => {
        expect(() => parseLocomo([{ conversation: {}, qa: [] }])).toThrow(/sample_id/);
    });

    test("parseLocomo throws on missing session_N_date_time", () => {
        const bad = [
            {
                sample_id: "x",
                conversation: { session_1: [] },
                qa: [],
            },
        ];
        expect(() => parseLocomo(bad)).toThrow(/date_time/);
    });

    test("parseLocomo throws on non-string evidence entry", () => {
        const bad = [
            {
                sample_id: "x",
                conversation: { session_1: [], session_1_date_time: "2024-01-01" },
                qa: [
                    {
                        question: "q",
                        answer: "a",
                        category: "c",
                        evidence: [1],
                    },
                ],
            },
        ];
        expect(() => parseLocomo(bad)).toThrow(/evidence/);
    });
});

describe("turnsToClaims (LOCOMO)", () => {
    test("produces one claim per turn with sample_id-prefixed, dia_id-suffixed ids", () => {
        const c = parseLocomo(FIXTURE)[0];
        const claims = turnsToClaims(c);
        // 3 turns in session_1 + 2 in session_2 + 2 in session_3 (one skipped) = 7
        expect(claims).toHaveLength(7);
        expect(claims[0].id).toBe("conv_alpha-D1:1");
        expect(claims[3].id).toBe("conv_alpha-D2:1");
        expect(claims[5].id).toBe("conv_alpha-D3:1");
    });

    test("validFrom is monotonic across the full conversation", () => {
        const c = parseLocomo(FIXTURE)[0];
        const claims = turnsToClaims(c);
        for (let i = 1; i < claims.length; i++) {
            expect(claims[i].validFrom).toBeGreaterThan(claims[i - 1].validFrom);
        }
    });

    test("deterministic ids across repeated calls", () => {
        const c = parseLocomo(FIXTURE)[0];
        const a = turnsToClaims(c).map((x) => x.id);
        const b = turnsToClaims(c).map((x) => x.id);
        expect(a).toEqual(b);
    });
});
