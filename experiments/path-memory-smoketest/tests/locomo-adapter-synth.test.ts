import { describe, test, expect } from "bun:test";
import { runLocomoConversation } from "../eval/locomo-adapter.js";
import type { LlmSynthesizer, SynthesisResult } from "../src/llm-synthesizer.js";
import { makeFakeEmbedder } from "./helpers.js";
import type { LocomoConversation } from "../data/locomo-loader.js";

function stubSynthesizer(answer: string): LlmSynthesizer {
    return {
        synthesize(question: string, claimTexts: string[]): Promise<SynthesisResult> {
            void question;
            void claimTexts;
            return Promise.resolve({
                answer,
                abstained: answer.toLowerCase() === "not mentioned",
                ms: 1,
            });
        },
        healthCheck(): Promise<void> {
            return Promise.resolve();
        },
    };
}

const CONV: LocomoConversation = {
    sampleId: "s1",
    skippedTurns: 0,
    sessions: [
        {
            sessionIndex: 0,
            timestamp: 1_700_000_000_000,
            turns: [
                { speaker: "A", diaId: "d1", text: "Alice moved to Boston in 2023." },
                { speaker: "A", diaId: "d2", text: "Alice adopted a dog." },
            ],
        },
    ],
    qa: [
        {
            category: "single-session-user",
            question: "Where did Alice move?",
            goldAnswer: "Boston",
            adversarial: false,
            adversarialAnswer: "",
            evidenceDiaIds: ["d1"],
        },
    ],
};

describe("runLocomoConversation — synthesizer hook", () => {
    test("populates synthesizedAnswer when synthesizer is provided", async () => {
        const embedder = makeFakeEmbedder();
        const result = await runLocomoConversation(CONV, {
            embedder,
            synthesizer: stubSynthesizer("Boston"),
        });
        expect(result.questions.length).toBe(1);
        const q = result.questions[0];
        expect(q.synthesizedAnswer).toBe("Boston");
        expect(q.synthAbstained).toBe(false);
        expect(q.synthMs).toBeGreaterThanOrEqual(0);
    });

    test("leaves synthesizedAnswer undefined when no synthesizer", async () => {
        const embedder = makeFakeEmbedder();
        const result = await runLocomoConversation(CONV, { embedder });
        const q = result.questions[0];
        expect(q.synthesizedAnswer).toBeUndefined();
        expect(q.synthAbstained).toBeUndefined();
        expect(q.synthMs).toBeUndefined();
    });
});
