import type { EmbeddingAdapter } from "../../../src/core/types.js";
import type { GraphIndex } from "../src/graph.js";
import type { MemoryStore } from "../src/store.js";

const DIM = 384;

function hashStr(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function pseudoVec(seed: number): number[] {
    const v = new Array<number>(DIM);
    let state = seed || 1;
    let norm = 0;
    for (let i = 0; i < DIM; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        const x = (state / 0xffffffff) * 2 - 1;
        v[i] = x;
        norm += x * x;
    }
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < DIM; i++) v[i] *= inv;
    return v;
}

export function makeFakeEmbedder(): EmbeddingAdapter {
    const cache = new Map<string, number[]>();
    const embed = (text: string): Promise<number[]> => {
        const hit = cache.get(text);
        if (hit) return Promise.resolve(hit);
        const v = pseudoVec(hashStr(text));
        cache.set(text, v);
        return Promise.resolve(v);
    };
    return {
        dimension: DIM,
        embed,
        async embedBatch(texts: string[]): Promise<number[][]> {
            const out: number[][] = [];
            for (const t of texts) out.push(await embed(t));
            return out;
        },
    };
}

export function trivialTokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0);
}

export function wireGraphToStore(store: MemoryStore, graph: GraphIndex): () => void {
    return store.subscribe((event) => {
        if (event.kind === "ingested") graph.addClaim(event.claim);
    });
}
