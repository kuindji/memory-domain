import { describe, test, expect } from "bun:test";
import {
    finalSessionPersonas,
    groupMscByDialogue,
    parseMscRows,
    turnsToClaims,
} from "../data/msc-loader.js";

// Phase 7.5 — MSC loader smoke tests. Inline fixture mirrors the HF
// datasets-server row shape.

const FIXTURE = [
    {
        dataset: "MSC",
        dialoug_id: 0,
        session_id: 0,
        persona1: ["I like hiking.", "I work in marketing."],
        persona2: ["I own a dog."],
        dialogue: [
            "Do you enjoy outdoor activities?",
            "Yes, I have a dog I walk daily.",
            "Nice, hiking is my thing.",
        ],
        speaker: ["Speaker 1", "Speaker 2", "Speaker 1"],
    },
    {
        dataset: "MSC",
        dialoug_id: 0,
        session_id: 1,
        persona1: ["I like hiking.", "I work in marketing.", "I just bought a Jeep."],
        persona2: ["I own a dog.", "I love grilling."],
        dialogue: ["How was your weekend?", "Great! Grilled some steaks."],
        speaker: ["Speaker 1", "Speaker 2"],
    },
    {
        dataset: "MSC",
        dialoug_id: 1,
        session_id: 0,
        persona1: ["I play guitar."],
        persona2: ["I teach yoga."],
        dialogue: ["Hey, long time no see.", "Yeah, been busy teaching."],
        speaker: ["Speaker 1", "Speaker 2"],
    },
];

describe("MSC loader", () => {
    test("parseMscRows normalizes each row", () => {
        const rows = parseMscRows(FIXTURE);
        expect(rows).toHaveLength(3);
        expect(rows[0].dialoug_id).toBe(0);
        expect(rows[0].session_id).toBe(0);
        expect(rows[0].dialogue).toHaveLength(3);
    });

    test("parseMscRows throws on dialogue/speaker length mismatch", () => {
        const bad = [
            {
                ...FIXTURE[0],
                speaker: ["Speaker 1"],
            },
        ];
        expect(() => parseMscRows(bad)).toThrow(/mismatch/);
    });

    test("parseMscRows throws on missing dialoug_id", () => {
        const bad = [{ ...FIXTURE[0], dialoug_id: undefined }];
        expect(() => parseMscRows(bad)).toThrow(/dialoug_id/);
    });

    test("groupMscByDialogue sorts sessions and preserves turns", () => {
        const dialogues = groupMscByDialogue(parseMscRows(FIXTURE));
        expect(dialogues).toHaveLength(2);
        const d0 = dialogues.find((d) => d.dialogueId === 0);
        expect(d0).toBeDefined();
        expect(d0?.sessions).toHaveLength(2);
        expect(d0?.sessions[0].sessionId).toBe(0);
        expect(d0?.sessions[1].sessionId).toBe(1);
        expect(d0?.sessions[0].turns).toHaveLength(3);
        expect(d0?.sessions[0].turns[0]).toEqual({
            speaker: "Speaker 1",
            text: "Do you enjoy outdoor activities?",
        });
    });

    test("groupMscByDialogue rejects speaker labels outside Speaker 1 | Speaker 2", () => {
        const bad = parseMscRows([
            {
                ...FIXTURE[0],
                speaker: ["Speaker 1", "System", "Speaker 1"],
            },
        ]);
        expect(() => groupMscByDialogue(bad)).toThrow(/speaker/i);
    });
});

describe("turnsToClaims (MSC)", () => {
    test("produces one claim per utterance with session/turn-indexed ids", () => {
        const dialogues = groupMscByDialogue(parseMscRows(FIXTURE));
        const d0 = dialogues.find((d) => d.dialogueId === 0);
        if (!d0) throw new Error("dialogue 0 missing");
        const claims = turnsToClaims(d0);
        // 3 turns in session 0 + 2 in session 1 = 5
        expect(claims).toHaveLength(5);
        expect(claims[0].id).toBe("0-s0-t0");
        expect(claims[3].id).toBe("0-s1-t0");
    });

    test("synthetic validFrom preserves session and turn order across the dialogue", () => {
        const dialogues = groupMscByDialogue(parseMscRows(FIXTURE));
        const d0 = dialogues.find((d) => d.dialogueId === 0);
        if (!d0) throw new Error("dialogue 0 missing");
        const claims = turnsToClaims(d0);
        for (let i = 1; i < claims.length; i++) {
            expect(claims[i].validFrom).toBeGreaterThan(claims[i - 1].validFrom);
        }
    });
});

describe("finalSessionPersonas", () => {
    test("returns the last session's accumulated persona lists", () => {
        const dialogues = groupMscByDialogue(parseMscRows(FIXTURE));
        const d0 = dialogues.find((d) => d.dialogueId === 0);
        if (!d0) throw new Error("dialogue 0 missing");
        const personas = finalSessionPersonas(d0);
        expect(personas.persona1).toContain("I just bought a Jeep.");
        expect(personas.persona2).toContain("I love grilling.");
    });
});
