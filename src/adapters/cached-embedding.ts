/**
 * Caching decorator for an EmbeddingAdapter.
 *
 * Embedding inference (e.g. ONNX BERT) is deterministic for a fixed model,
 * so text -> vector can be safely memoized. Recurring short queries
 * (topic names, tags, entity labels) dominate in ingestion and search
 * workloads; caching avoids repeated model runs.
 */

import type { EmbeddingAdapter } from "../core/types.js";

interface CachedEmbeddingOptions {
    maxEntries?: number;
}

class CachedEmbeddingAdapter implements EmbeddingAdapter {
    readonly dimension: number;
    private readonly inner: EmbeddingAdapter;
    private readonly maxEntries: number;
    private readonly cache = new Map<string, number[]>();

    constructor(inner: EmbeddingAdapter, options: CachedEmbeddingOptions = {}) {
        this.inner = inner;
        this.dimension = inner.dimension;
        this.maxEntries = options.maxEntries ?? 10_000;
    }

    async embed(text: string): Promise<number[]> {
        const hit = this.cache.get(text);
        if (hit) return hit;
        const vec = await this.inner.embed(text);
        this.store(text, vec);
        return vec;
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        const out = new Array<number[]>(texts.length);
        const missIndexes: number[] = [];
        const missTexts: string[] = [];

        for (let i = 0; i < texts.length; i++) {
            const hit = this.cache.get(texts[i]);
            if (hit) {
                out[i] = hit;
            } else {
                missIndexes.push(i);
                missTexts.push(texts[i]);
            }
        }

        if (missTexts.length > 0) {
            const vecs = await this.inner.embedBatch(missTexts);
            for (let j = 0; j < missTexts.length; j++) {
                const idx = missIndexes[j];
                const vec = vecs[j];
                out[idx] = vec;
                this.store(missTexts[j], vec);
            }
        }

        return out;
    }

    private store(key: string, vec: number[]): void {
        if (this.cache.size >= this.maxEntries) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(key, vec);
    }
}

export { CachedEmbeddingAdapter };
export type { CachedEmbeddingOptions };
