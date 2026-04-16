import type { EmbeddingAdapter } from "../../../src/core/types.js";
import { cosineSimilarity } from "../../../src/core/scoring.js";
import type { MemoryStore } from "../src/store.js";
import type { Claim, ClaimId, RetrievalMode } from "../src/types.js";

export type ScoredBaselineClaim = {
    id: ClaimId;
    claim: Claim;
    score: number;
};

export class FlatVectorBaseline {
    constructor(
        private readonly embedder: EmbeddingAdapter,
        private readonly store: MemoryStore,
    ) {}

    async query(
        text: string,
        opts: { topK?: number; mode?: RetrievalMode } = {},
    ): Promise<ScoredBaselineClaim[]> {
        const topK = opts.topK ?? 5;
        const mode: RetrievalMode = opts.mode ?? "current";
        const queryVec = await this.embedder.embed(text);
        const claims = this.store.allClaims().filter((c) => isValidIn(c, mode));
        const scored = claims.map((c) => ({
            id: c.id,
            claim: c,
            score: cosineSimilarity(queryVec, c.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }
}

function isValidIn(c: Claim, mode: RetrievalMode): boolean {
    if (mode === "current") return c.validUntil === Number.POSITIVE_INFINITY;
    return c.validFrom <= mode.at && mode.at < c.validUntil;
}
