import { describe, test, expect } from "bun:test";
import { getEmbedder } from "../src/embedder.js";

describe("embedder", () => {
    test("loads and produces 384-dim vectors", async () => {
        const emb = await getEmbedder();
        const v = await emb.embed("Alex moves to LA");
        expect(emb.dimension).toBe(384);
        expect(v.length).toBe(384);
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
});
