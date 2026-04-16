import { cosineSimilarity } from "../../../src/core/scoring.js";
import type { GraphIndex } from "./graph.js";
import type {
    Claim,
    ClaimId,
    Edge,
    EdgeType,
    Path,
    Probe,
    RetrievalMode,
    RetrievalOptions,
    ScoreBreakdown,
    ScoredPath,
    Timestamp,
    TraversalMode,
} from "./types.js";

const DEFAULTS = {
    anchorTopK: 5,
    bfsMaxDepth: 3,
    resultTopN: 10,
    traversal: "bfs" as TraversalMode,
    temporalHopCost: 0.5,
    weights: {
        probeCoverage: 1.0,
        edgeTypeDiversity: 0.3,
        recency: 0.1,
        pathQuality: 0,
        lengthPenalty: 0.1,
    },
};

export type RetrieverDeps = {
    graph: GraphIndex;
    similarity?: (a: number[], b: number[]) => number;
};

export class Retriever {
    private readonly graph: GraphIndex;
    private readonly similarity: (a: number[], b: number[]) => number;

    constructor(deps: RetrieverDeps) {
        this.graph = deps.graph;
        this.similarity = deps.similarity ?? cosineSimilarity;
    }

    retrieve(probes: Probe[], options: RetrievalOptions = {}): ScoredPath[] {
        if (probes.length === 0) return [];

        const mode: RetrievalMode = options.mode ?? "current";
        const anchorTopK = options.anchorTopK ?? DEFAULTS.anchorTopK;
        const bfsMaxDepth = options.bfsMaxDepth ?? DEFAULTS.bfsMaxDepth;
        const resultTopN = options.resultTopN ?? DEFAULTS.resultTopN;
        const traversal = options.traversal ?? DEFAULTS.traversal;
        const temporalHopCost = options.temporalHopCost ?? DEFAULTS.temporalHopCost;
        const weights = { ...DEFAULTS.weights, ...options.weights };

        const isValid = makeValidityFilter(mode);
        const validClaims = this.graph
            .nodeIds()
            .map((id) => this.graph.getNode(id))
            .filter((c): c is Claim => c !== undefined && isValid(c));

        const anchorsByProbe: ClaimId[][] = probes.map((p) =>
            this.findAnchors(p.embedding, validClaims, anchorTopK),
        );

        const probesByAnchor = new Map<ClaimId, Set<number>>();
        anchorsByProbe.forEach((anchors, pIdx) => {
            for (const aid of anchors) {
                let set = probesByAnchor.get(aid);
                if (!set) {
                    set = new Set<number>();
                    probesByAnchor.set(aid, set);
                }
                set.add(pIdx);
            }
        });

        const allAnchors = Array.from(probesByAnchor.keys());
        const candidatePaths = new Map<string, Path>();

        for (const aid of allAnchors) {
            candidatePaths.set(`solo:${aid}`, { nodeIds: [aid], edges: [] });
        }

        for (let i = 0; i < allAnchors.length; i++) {
            const reachable =
                traversal === "dijkstra"
                    ? this.shortestCostPaths(allAnchors[i], bfsMaxDepth, isValid, temporalHopCost)
                    : this.bfsShortestPaths(allAnchors[i], bfsMaxDepth, isValid);
            for (let j = i + 1; j < allAnchors.length; j++) {
                const path = reachable.get(allAnchors[j]);
                if (!path) continue;
                const canonical = canonicalPathKey(path);
                if (!candidatePaths.has(canonical)) {
                    candidatePaths.set(canonical, path);
                }
            }
        }

        const now = this.computeNow();
        const numProbes = probes.length;
        const scored: ScoredPath[] = [];

        for (const path of candidatePaths.values()) {
            const breakdown = this.scorePath(path, probesByAnchor, numProbes, now, bfsMaxDepth);
            const score =
                breakdown.probeCoverage * weights.probeCoverage +
                breakdown.edgeTypeDiversity * weights.edgeTypeDiversity +
                breakdown.recency * weights.recency +
                breakdown.pathQuality * weights.pathQuality -
                breakdown.lengthPenalty * weights.lengthPenalty;
            scored.push({ path, score, breakdown });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, resultTopN);
    }

    private findAnchors(probeEmbedding: number[], claims: Claim[], topK: number): ClaimId[] {
        const scored = claims.map((c) => ({
            id: c.id,
            sim: this.similarity(probeEmbedding, c.embedding),
        }));
        scored.sort((a, b) => b.sim - a.sim);
        return scored.slice(0, topK).map((s) => s.id);
    }

    private bfsShortestPaths(
        start: ClaimId,
        maxDepth: number,
        isValid: (c: Claim) => boolean,
    ): Map<ClaimId, Path> {
        const result = new Map<ClaimId, Path>();
        type QItem = { id: ClaimId; depth: number; nodes: ClaimId[]; edges: Edge[] };
        const visited = new Set<ClaimId>([start]);
        const queue: QItem[] = [{ id: start, depth: 0, nodes: [start], edges: [] }];
        let head = 0;

        while (head < queue.length) {
            const cur = queue[head++];
            if (cur.depth >= maxDepth) continue;
            const neighbors = this.graph.neighbors(cur.id);
            for (const e of neighbors) {
                if (visited.has(e.to)) continue;
                const node = this.graph.getNode(e.to);
                if (!node || !isValid(node)) continue;
                visited.add(e.to);
                const path: Path = {
                    nodeIds: [...cur.nodes, e.to],
                    edges: [...cur.edges, e],
                };
                result.set(e.to, path);
                queue.push({
                    id: e.to,
                    depth: cur.depth + 1,
                    nodes: path.nodeIds,
                    edges: path.edges,
                });
            }
        }

        return result;
    }

    /**
     * Bounded-depth lowest-cost path search (Phase-1.5 opt-in traversal).
     * Lexical/semantic edge cost = max(0, 1 - edge.weight). Temporal edges
     * cost a fixed `temporalHopCost` (default 0.5) — a real signal but not
     * a free corpus-wide highway. On tier-1 at default weights this did
     * not lift mean F1 above BFS (primitive-limited, not tuning-limited);
     * ships as infrastructure for tier-2 and future experiments.
     */
    private shortestCostPaths(
        start: ClaimId,
        maxDepth: number,
        isValid: (c: Claim) => boolean,
        temporalHopCost: number,
    ): Map<ClaimId, Path> {
        type State = { id: ClaimId; cost: number; depth: number; path: Path };
        const bestCost = new Map<ClaimId, number>();
        const result = new Map<ClaimId, Path>();
        bestCost.set(start, 0);

        const pq: State[] = [
            { id: start, cost: 0, depth: 0, path: { nodeIds: [start], edges: [] } },
        ];

        while (pq.length > 0) {
            pq.sort((a, b) => a.cost - b.cost || a.depth - b.depth);
            const cur = pq.shift()!;

            const known = bestCost.get(cur.id);
            if (known !== undefined && cur.cost > known) continue;

            if (cur.id !== start && !result.has(cur.id)) {
                result.set(cur.id, cur.path);
            }

            if (cur.depth >= maxDepth) continue;

            for (const e of this.graph.neighbors(cur.id)) {
                if (cur.path.nodeIds.includes(e.to)) continue;
                const node = this.graph.getNode(e.to);
                if (!node || !isValid(node)) continue;

                const edgeCost =
                    e.type === "temporal" ? temporalHopCost : Math.max(0, 1 - e.weight);
                const newCost = cur.cost + edgeCost;
                const prev = bestCost.get(e.to);
                if (prev !== undefined && prev <= newCost) continue;

                bestCost.set(e.to, newCost);
                pq.push({
                    id: e.to,
                    cost: newCost,
                    depth: cur.depth + 1,
                    path: {
                        nodeIds: [...cur.path.nodeIds, e.to],
                        edges: [...cur.path.edges, e],
                    },
                });
            }
        }

        return result;
    }

    private computeNow(): Timestamp {
        let max = 0;
        for (const id of this.graph.nodeIds()) {
            const n = this.graph.getNode(id);
            if (n && Number.isFinite(n.validFrom) && n.validFrom > max) max = n.validFrom;
        }
        return max;
    }

    private scorePath(
        path: Path,
        probesByAnchor: Map<ClaimId, Set<number>>,
        numProbes: number,
        now: Timestamp,
        maxDepth: number,
    ): ScoreBreakdown {
        const coveredProbes = new Set<number>();
        for (const nid of path.nodeIds) {
            const p = probesByAnchor.get(nid);
            if (p) for (const idx of p) coveredProbes.add(idx);
        }
        const probeCoverage = numProbes > 0 ? coveredProbes.size / numProbes : 0;

        const edgeTypes = new Set<EdgeType>();
        for (const e of path.edges) edgeTypes.add(e.type);
        const edgeTypeDiversity = edgeTypes.size / 3;

        let mostRecent = 0;
        for (const nid of path.nodeIds) {
            const n = this.graph.getNode(nid);
            if (n && n.validFrom > mostRecent) mostRecent = n.validFrom;
        }
        const recency = now > 0 ? mostRecent / now : 0;

        const hops = Math.max(0, path.nodeIds.length - 1);
        let anchorsInPath = 0;
        for (const nid of path.nodeIds) {
            if (probesByAnchor.has(nid)) anchorsInPath++;
        }
        const informationalHops = Math.max(0, hops - Math.max(0, anchorsInPath - 1));
        const lengthPenalty = maxDepth > 0 ? informationalHops / maxDepth : 0;

        let pathQuality: number;
        if (path.edges.length === 0) {
            pathQuality = 0;
        } else {
            let sum = 0;
            for (const e of path.edges) sum += e.weight;
            pathQuality = sum / path.edges.length;
        }

        return { probeCoverage, edgeTypeDiversity, recency, pathQuality, lengthPenalty };
    }
}

function makeValidityFilter(mode: RetrievalMode): (c: Claim) => boolean {
    if (mode === "current") {
        return (c) => c.validUntil === Number.POSITIVE_INFINITY;
    }
    const t = mode.at;
    return (c) => c.validFrom <= t && t < c.validUntil;
}

function canonicalPathKey(path: Path): string {
    const sorted = [...path.nodeIds].sort();
    return `path:${sorted.join(",")}`;
}
