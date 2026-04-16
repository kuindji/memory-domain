import { cosineSimilarity } from "../../../src/core/scoring.js";
import type { Claim, ClaimId, Edge, EdgeType } from "./types.js";

export type GraphConfig = {
    semanticThreshold?: number;
    similarity?: (a: number[], b: number[]) => number;
};

const DEFAULT_SEMANTIC_THRESHOLD = 0.65;

export class GraphIndex {
    private readonly nodes = new Map<ClaimId, Claim>();
    private readonly adjacency = new Map<ClaimId, Edge[]>();
    private readonly temporalChain: ClaimId[] = [];
    private readonly semanticThreshold: number;
    private readonly similarity: (a: number[], b: number[]) => number;

    constructor(config: GraphConfig = {}) {
        this.semanticThreshold = config.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;
        this.similarity = config.similarity ?? cosineSimilarity;
    }

    addClaim(claim: Claim): void {
        if (this.nodes.has(claim.id)) {
            throw new Error(`Claim ${claim.id} already in graph`);
        }
        this.nodes.set(claim.id, claim);
        this.adjacency.set(claim.id, []);

        for (const otherId of this.nodes.keys()) {
            if (otherId === claim.id) continue;
            const other = this.nodes.get(otherId);
            if (!other) continue;
            this.buildLexicalAndSemanticEdges(claim, other);
        }

        this.insertIntoTemporalChain(claim);
    }

    getNode(id: ClaimId): Claim | undefined {
        return this.nodes.get(id);
    }

    nodeIds(): ClaimId[] {
        return Array.from(this.nodes.keys());
    }

    neighbors(id: ClaimId, types?: EdgeType[]): Edge[] {
        const all = this.adjacency.get(id) ?? [];
        if (!types || types.length === 0) return all;
        const set = new Set(types);
        return all.filter((e) => set.has(e.type));
    }

    allEdges(): Edge[] {
        const out: Edge[] = [];
        for (const list of this.adjacency.values()) out.push(...list);
        return out;
    }

    private buildLexicalAndSemanticEdges(a: Claim, b: Claim): void {
        const aSet = new Set(a.tokens);
        const bSet = new Set(b.tokens);
        const shared: string[] = [];
        for (const t of aSet) if (bSet.has(t)) shared.push(t);

        if (shared.length >= 1) {
            const unionSize = aSet.size + bSet.size - shared.length;
            const jaccard = unionSize > 0 ? shared.length / unionSize : 0;
            this.pushBidirectional({
                type: "lexical",
                from: a.id,
                to: b.id,
                weight: jaccard,
                meta: { sharedTokens: shared },
            });
        }

        const sim = this.similarity(a.embedding, b.embedding);
        if (sim >= this.semanticThreshold) {
            this.pushBidirectional({
                type: "semantic",
                from: a.id,
                to: b.id,
                weight: sim,
                meta: { similarity: sim },
            });
        }
    }

    private insertIntoTemporalChain(claim: Claim): void {
        let i = 0;
        while (i < this.temporalChain.length) {
            const existingId = this.temporalChain[i];
            const existing = this.nodes.get(existingId);
            if (!existing) break;
            if (existing.validFrom > claim.validFrom) break;
            i++;
        }

        const prevId = i > 0 ? this.temporalChain[i - 1] : undefined;
        const nextId = i < this.temporalChain.length ? this.temporalChain[i] : undefined;

        if (prevId !== undefined && nextId !== undefined) {
            this.removeTemporalEdge(prevId, nextId);
        }

        this.temporalChain.splice(i, 0, claim.id);

        if (prevId !== undefined) {
            const prev = this.nodes.get(prevId);
            if (prev) {
                this.pushBidirectional({
                    type: "temporal",
                    from: prev.id,
                    to: claim.id,
                    weight: 1,
                    meta: { deltaT: claim.validFrom - prev.validFrom },
                });
            }
        }
        if (nextId !== undefined) {
            const next = this.nodes.get(nextId);
            if (next) {
                this.pushBidirectional({
                    type: "temporal",
                    from: claim.id,
                    to: next.id,
                    weight: 1,
                    meta: { deltaT: next.validFrom - claim.validFrom },
                });
            }
        }
    }

    private pushBidirectional(edge: Edge): void {
        this.pushOne(edge);
        this.pushOne({ ...edge, from: edge.to, to: edge.from });
    }

    private pushOne(edge: Edge): void {
        const list = this.adjacency.get(edge.from);
        if (list) list.push(edge);
        else this.adjacency.set(edge.from, [edge]);
    }

    private removeTemporalEdge(a: ClaimId, b: ClaimId): void {
        for (const [src, dst] of [
            [a, b],
            [b, a],
        ] as const) {
            const list = this.adjacency.get(src);
            if (!list) continue;
            const idx = list.findIndex((e) => e.type === "temporal" && e.to === dst);
            if (idx >= 0) list.splice(idx, 1);
        }
    }
}
