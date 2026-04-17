import { describe, test, expect } from "bun:test";
import { getEmbedder, resolveEncoder, ENCODER_DIMS } from "../src/embedder.js";

const ENCODER = resolveEncoder();
const EXPECTED_DIM = ENCODER_DIMS[ENCODER];

describe(`embedder (${ENCODER})`, () => {
    test(`loads and produces ${EXPECTED_DIM}-dim vectors`, async () => {
        const emb = await getEmbedder();
        const v = await emb.embed("Alex moves to LA");
        expect(emb.dimension).toBe(EXPECTED_DIM);
        expect(v.length).toBe(EXPECTED_DIM);
        // L2 norm should be ~1 since the underlying adapter normalizes
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        expect(norm).toBeGreaterThan(0.99);
        expect(norm).toBeLessThan(1.01);
    });

    test("returns identical vectors for identical text (cache hit)", async () => {
        const emb = await getEmbedder();
        const a = await emb.embed("identical text smoke test");
        const b = await emb.embed("identical text smoke test");
        expect(a).toBe(b); // cache returns same reference
    });

    test("semantically-different sentences produce materially different vectors", async () => {
        const emb = await getEmbedder();
        const a = await emb.embed(
            "The photosynthesis process converts sunlight into chemical energy.",
        );
        const b = await emb.embed("Mount Everest is the tallest peak above sea level.");
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
        // Both are L2-normalized so dot == cosine. A vocab/pooling mismatch
        // tends to produce near-degenerate vectors; require real separation.
        expect(dot).toBeLessThan(0.95);
    });
});
