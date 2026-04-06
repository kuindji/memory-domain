import { describe, test, expect } from "bun:test";
import { classifyQueryIntent } from "../src/domains/kb/utils.js";
import type { LLMAdapter } from "../src/core/types.js";

function mockLlm(response: string): LLMAdapter {
    return {
        extract: () => Promise.resolve([]),
        consolidate: () => Promise.resolve(""),
        generate: () => Promise.resolve(response),
    };
}

describe("classifyQueryIntent", () => {
    test("parses valid JSON response from LLM", async () => {
        const llm = mockLlm(
            '{"classifications": ["fact", "reference"], "keywords": ["commission", "rate"], "topic": "commissions"}',
        );
        const intent = await classifyQueryIntent("What is the commission rate?", llm);
        expect(intent.classifications).toEqual(["fact", "reference"]);
        expect(intent.keywords).toEqual(["commission", "rate"]);
        expect(intent.topic).toBe("commissions");
    });

    test("filters out invalid classifications", async () => {
        const llm = mockLlm(
            '{"classifications": ["fact", "invalid", "how-to"], "keywords": ["test"]}',
        );
        const intent = await classifyQueryIntent("test query", llm);
        expect(intent.classifications).toEqual(["fact", "how-to"]);
    });

    test("returns all classifications on LLM failure", async () => {
        const llm: LLMAdapter = {
            extract: () => Promise.resolve([]),
            consolidate: () => Promise.resolve(""),
            generate: () => Promise.reject(new Error("LLM unavailable")),
        };
        const intent = await classifyQueryIntent("test query", llm);
        expect(intent.classifications).toHaveLength(6);
        expect(intent.keywords.length).toBeGreaterThan(0);
    });

    test("returns all classifications when LLM returns unparseable response", async () => {
        const llm = mockLlm("I don't understand the question");
        const intent = await classifyQueryIntent("test query", llm);
        expect(intent.classifications).toHaveLength(6);
    });

    test("returns all classifications when generate is not available", async () => {
        const llm: LLMAdapter = {
            extract: () => Promise.resolve([]),
            consolidate: () => Promise.resolve(""),
        };
        const intent = await classifyQueryIntent("test query", llm);
        expect(intent.classifications).toHaveLength(6);
    });
});
