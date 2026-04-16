import { cosineSimilarity } from "../../../src/core/scoring.js";
import type { Claim, ClaimId, Edge, EdgeType } from "./types.js";

export type GraphConfig = {
    semanticThreshold?: number;
    similarity?: (a: number[], b: number[]) => number;
    lexicalIdfFloor?: number;
    /**
     * If set, temporal edges receive `weight = exp(-deltaT / tau)` instead of
     * the default uniform `weight = 1`. Used by Dijkstra to prefer close-in-
     * time adjacency over distant adjacency. BFS ignores edge weights.
     */
    temporalDecayTau?: number;
};

const DEFAULT_SEMANTIC_THRESHOLD = 0.65;
const DEFAULT_LEXICAL_IDF_FLOOR = 0;

export class GraphIndex {
    private readonly nodes = new Map<ClaimId, Claim>();
    private readonly adjacency = new Map<ClaimId, Edge[]>();
    private readonly temporalChain: ClaimId[] = [];
    private readonly documentFrequency = new Map<string, number>();
    private documentCount = 0;
    private readonly semanticThreshold: number;
    private readonly similarity: (a: number[], b: number[]) => number;
    private readonly lexicalIdfFloor: number;
    private readonly temporalDecayTau: number | undefined;

    constructor(config: GraphConfig = {}) {
        this.semanticThreshold = config.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;
        this.similarity = config.similarity ?? cosineSimilarity;
        this.lexicalIdfFloor = config.lexicalIdfFloor ?? DEFAULT_LEXICAL_IDF_FLOOR;
        this.temporalDecayTau = config.temporalDecayTau;
    }

    addClaim(claim: Claim): void {
        if (this.nodes.has(claim.id)) {
            throw new Error(`Claim ${claim.id} already in graph`);
        }
        this.nodes.set(claim.id, claim);
        this.adjacency.set(claim.id, []);

        for (const token of new Set(claim.tokens)) {
            this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
        }
        this.documentCount++;

        for (const otherId of this.nodes.keys()) {
            if (otherId === claim.id) continue;
            const other = this.nodes.get(otherId);
            if (!other) continue;
            this.buildLexicalAndSemanticEdges(claim, other);
        }

        this.recomputeLexicalWeights();

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

    idf(token: string): number {
        const df = this.documentFrequency.get(token) ?? 0;
        return Math.log((this.documentCount + 1) / (df + 1)) + 1;
    }

    temporalDecayEnabled(): boolean {
        return this.temporalDecayTau !== undefined && this.temporalDecayTau > 0;
    }

    /**
     * Sum of IDF over a claim's distinct tokens. Used by graph-informed
     * anchor scoring (Phase 1.6 A2) to bias anchor selection toward nodes
     * whose tokens carry more information mass than ubiquitous-token nodes.
     */
    nodeIdfMass(id: ClaimId): number {
        const node = this.nodes.get(id);
        if (!node) return 0;
        let sum = 0;
        for (const t of new Set(node.tokens)) sum += this.idf(t);
        return sum;
    }

    private lexicalWeight(sharedTokens: string[], unionTokens: string[]): number {
        let sharedIdf = 0;
        for (const t of sharedTokens) sharedIdf += this.idf(t);
        let unionIdf = 0;
        for (const t of unionTokens) unionIdf += this.idf(t);
        return unionIdf > 0 ? sharedIdf / unionIdf : 0;
    }

    private buildLexicalAndSemanticEdges(a: Claim, b: Claim): void {
        const aSet = new Set(a.tokens);
        const bSet = new Set(b.tokens);
        const shared: string[] = [];
        const union: string[] = [];
        for (const t of aSet) {
            union.push(t);
            if (bSet.has(t)) shared.push(t);
        }
        for (const t of bSet) {
            if (!aSet.has(t)) union.push(t);
        }

        if (shared.length >= 1) {
            const weight = this.lexicalWeight(shared, union);
            if (weight >= this.lexicalIdfFloor) {
                this.pushBidirectional({
                    type: "lexical",
                    from: a.id,
                    to: b.id,
                    weight,
                    meta: { sharedTokens: shared, unionTokens: union },
                });
            }
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

    private recomputeLexicalWeights(): void {
        for (const list of this.adjacency.values()) {
            for (const edge of list) {
                if (edge.type !== "lexical") continue;
                const shared = edge.meta?.sharedTokens;
                const union = edge.meta?.unionTokens;
                if (!shared || !union) continue;
                edge.weight = this.lexicalWeight(shared, union);
            }
        }
    }

    private temporalWeight(deltaT: number): number {
        if (this.temporalDecayTau === undefined || this.temporalDecayTau <= 0) return 1;
        const dt = Math.max(0, deltaT);
        return Math.exp(-dt / this.temporalDecayTau);
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
                const deltaT = claim.validFrom - prev.validFrom;
                this.pushBidirectional({
                    type: "temporal",
                    from: prev.id,
                    to: claim.id,
                    weight: this.temporalWeight(deltaT),
                    meta: { deltaT },
                });
            }
        }
        if (nextId !== undefined) {
            const next = this.nodes.get(nextId);
            if (next) {
                const deltaT = next.validFrom - claim.validFrom;
                this.pushBidirectional({
                    type: "temporal",
                    from: claim.id,
                    to: next.id,
                    weight: this.temporalWeight(deltaT),
                    meta: { deltaT },
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
