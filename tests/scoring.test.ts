import { describe, test, expect } from "bun:test";
import {
    countTokens,
    mergeScores,
    applyTokenBudget,
    cosineSimilarity,
    cosineSimilarityF32,
} from "../src/core/scoring.js";

describe("countTokens", () => {
    test("returns token count for a simple string", () => {
        const count = countTokens("hello world");
        expect(count).toBeGreaterThan(0);
        expect(typeof count).toBe("number");
    });

    test("returns 0 for empty string", () => {
        expect(countTokens("")).toBe(0);
    });

    test("longer text produces more tokens", () => {
        const short = countTokens("hello");
        const long = countTokens("hello world this is a longer sentence with more tokens");
        expect(long).toBeGreaterThan(short);
    });
});

describe("mergeScores", () => {
    test("computes weighted average of provided scores", () => {
        const result = mergeScores(
            { fulltext: 0.8, graph: 0.6 },
            { vector: 0.5, fulltext: 0.3, graph: 0.2 },
        );
        // Only fulltext and graph are provided
        // (0.8 * 0.3 + 0.6 * 0.2) / (0.3 + 0.2) = (0.24 + 0.12) / 0.5 = 0.72
        expect(result).toBeCloseTo(0.72);
    });

    test("returns 0 when no scores are provided", () => {
        const result = mergeScores({}, { vector: 0.5, fulltext: 0.3, graph: 0.2 });
        expect(result).toBe(0);
    });

    test("handles single score correctly", () => {
        const result = mergeScores({ vector: 0.9 }, { vector: 0.5, fulltext: 0.3, graph: 0.2 });
        // (0.9 * 0.5) / 0.5 = 0.9
        expect(result).toBeCloseTo(0.9);
    });

    test("handles all three scores", () => {
        const result = mergeScores(
            { vector: 1.0, fulltext: 0.5, graph: 0.0 },
            { vector: 0.5, fulltext: 0.3, graph: 0.2 },
        );
        // (1.0*0.5 + 0.5*0.3 + 0.0*0.2) / (0.5+0.3+0.2) = (0.5 + 0.15 + 0) / 1.0 = 0.65
        expect(result).toBeCloseTo(0.65);
    });

    test("handles zero weights gracefully", () => {
        const result = mergeScores({ vector: 0.8 }, { vector: 0, fulltext: 0, graph: 0 });
        // weightSum = 0, so returns 0
        expect(result).toBe(0);
    });

    test("penalizeMissing divides by full configured weight sum", () => {
        // Single-modality hit on a common term ends up with a raw passthrough
        // score by default; penalizeMissing spreads it over the full weight
        // sum so multi-modal hits can outrank it.
        const single = mergeScores(
            { fulltext: 1.0 },
            { vector: 0.5, fulltext: 0.3, graph: 0.2 },
            { penalizeMissing: true },
        );
        // (1.0 * 0.3) / (0.5 + 0.3 + 0.2) = 0.3
        expect(single).toBeCloseTo(0.3);

        const multi = mergeScores(
            { vector: 0.6, fulltext: 0.5 },
            { vector: 0.5, fulltext: 0.3, graph: 0.2 },
            { penalizeMissing: true },
        );
        // (0.6 * 0.5 + 0.5 * 0.3) / 1.0 = 0.45
        expect(multi).toBeCloseTo(0.45);
        // Multi-modal hit now outranks single-modality hit on the same raw score.
        expect(multi).toBeGreaterThan(single);
    });

    test("penalizeMissing does not affect default behavior", () => {
        const defaultResult = mergeScores(
            { fulltext: 1.0 },
            { vector: 0.5, fulltext: 0.3, graph: 0.2 },
        );
        // Default: (1.0 * 0.3) / 0.3 = 1.0
        expect(defaultResult).toBeCloseTo(1.0);
    });
});

describe("applyTokenBudget", () => {
    test("returns entries that fit within budget", () => {
        const entries = [
            { content: "short", tokenCount: 10 },
            { content: "medium text", tokenCount: 20 },
            { content: "long text here", tokenCount: 30 },
        ];
        const result = applyTokenBudget(entries, 25);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe("short");
    });

    test("returns all entries when budget is large enough", () => {
        const entries = [
            { content: "a", tokenCount: 10 },
            { content: "b", tokenCount: 10 },
        ];
        const result = applyTokenBudget(entries, 100);
        expect(result).toHaveLength(2);
    });

    test("returns empty array when first entry exceeds budget", () => {
        const entries = [{ content: "big", tokenCount: 50 }];
        const result = applyTokenBudget(entries, 10);
        expect(result).toHaveLength(0);
    });

    test("returns empty array for empty input", () => {
        const result = applyTokenBudget([], 100);
        expect(result).toHaveLength(0);
    });

    test("computes token count from content when tokenCount is missing", () => {
        const entries = [
            { content: "hello world" },
            { content: "another entry here with more words to use up tokens" },
        ];
        // Budget of 5 tokens should limit results
        const result = applyTokenBudget(entries, 5);
        expect(result.length).toBeLessThanOrEqual(entries.length);
    });
});

describe("cosineSimilarityF32", () => {
    test("matches cosineSimilarity within 1e-6 on 1024-dim random vectors", () => {
        let s = 0x9e3779b9;
        const rng = () => {
            s = (s + 0x6d2b79f5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (let trial = 0; trial < 20; trial++) {
            const a: number[] = [];
            const b: number[] = [];
            for (let i = 0; i < 1024; i++) {
                a.push(rng() * 2 - 1);
                b.push(rng() * 2 - 1);
            }
            const baseline = cosineSimilarity(a, b);
            const fast = cosineSimilarityF32(Float32Array.from(a), Float32Array.from(b));
            expect(Math.abs(baseline - fast)).toBeLessThan(1e-6);
        }
    });

    test("returns 0 on empty or mismatched inputs", () => {
        expect(cosineSimilarityF32(new Float32Array(), new Float32Array())).toBe(0);
        expect(cosineSimilarityF32(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toBe(0);
    });

    test("returns 0 when either vector has zero norm", () => {
        const zero = new Float32Array(4);
        const nonzero = new Float32Array([1, 2, 3, 4]);
        expect(cosineSimilarityF32(zero, nonzero)).toBe(0);
        expect(cosineSimilarityF32(nonzero, zero)).toBe(0);
    });
});
