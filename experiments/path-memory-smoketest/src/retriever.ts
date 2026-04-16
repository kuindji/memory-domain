import { cosineSimilarity } from "../../../src/core/scoring.js";
import type { GraphIndex } from "./graph.js";
import type {
    AnchorScoring,
    Claim,
    ClaimId,
    Edge,
    EdgeType,
    Path,
    Probe,
    ProbeComposition,
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
    anchorScoring: { kind: "cosine" } as AnchorScoring,
    probeComposition: "union" as ProbeComposition,
    weightedFusionTau: 0.2,
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
        const anchorScoring = options.anchorScoring ?? DEFAULTS.anchorScoring;
        const probeComposition = options.probeComposition ?? DEFAULTS.probeComposition;
        const weightedFusionTau = options.weightedFusionTau ?? DEFAULTS.weightedFusionTau;
        const weights = { ...DEFAULTS.weights, ...options.weights };

        const isValid = makeValidityFilter(mode);
        const validClaims = this.graph
            .nodeIds()
            .map((id) => this.graph.getNode(id))
            .filter((c): c is Claim => c !== undefined && isValid(c));

        const probesByAnchor = this.composeAnchors({
            probes,
            validClaims,
            anchorTopK,
            anchorScoring,
            probeComposition,
            weightedFusionTau,
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

    /**
     * Per-probe top-K with the configured anchor scoring. Returns both the
     * ordered IDs and the per-anchor cosine — the cosine is reused by
     * weighted-fusion probe composition (A3).
     */
    private scoreAnchorsForProbe(
        probeEmbedding: number[],
        claims: Claim[],
        topK: number,
        scoring: AnchorScoring,
    ): { ranked: ClaimId[]; cosineByAnchor: Map<ClaimId, number> } {
        const cosineByAnchor = new Map<ClaimId, number>();
        let maxNodeIdf = 0;
        if (scoring.kind === "cosine-idf-mass") {
            for (const c of claims) {
                const m = this.graph.nodeIdfMass(c.id);
                if (m > maxNodeIdf) maxNodeIdf = m;
            }
        }

        const scored = claims.map((c) => {
            const sim = this.similarity(probeEmbedding, c.embedding);
            cosineByAnchor.set(c.id, sim);
            let score = sim;
            if (scoring.kind === "cosine-idf-mass" && maxNodeIdf > 0) {
                const norm = this.graph.nodeIdfMass(c.id) / maxNodeIdf;
                score = sim * (1 + scoring.alpha * norm);
            }
            return { id: c.id, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const ranked = scored.slice(0, topK).map((s) => s.id);
        return { ranked, cosineByAnchor };
    }

    /**
     * Compose per-probe anchor sets into a single `probesByAnchor` map.
     * - "union" (default): every probe's top-K contributes; an anchor records
     *   which probe(s) chose it.
     * - "intersection": anchor must appear in `>= ceil(P/2)` per-probe top-K
     *   sets, falling back to union when only one probe.
     * - "weighted-fusion": aggregate score per claim is
     *   `sum_p max(0, cosine(p, claim) - tau)`; top-K of aggregate are anchors,
     *   each anchor records every probe whose per-probe cosine cleared `tau`.
     */
    private composeAnchors(args: {
        probes: Probe[];
        validClaims: Claim[];
        anchorTopK: number;
        anchorScoring: AnchorScoring;
        probeComposition: ProbeComposition;
        weightedFusionTau: number;
    }): Map<ClaimId, Set<number>> {
        const { probes, validClaims, anchorTopK, anchorScoring, probeComposition } = args;

        const perProbe = probes.map((p) =>
            this.scoreAnchorsForProbe(p.embedding, validClaims, anchorTopK, anchorScoring),
        );

        const probesByAnchor = new Map<ClaimId, Set<number>>();
        const remember = (aid: ClaimId, pIdx: number): void => {
            let s = probesByAnchor.get(aid);
            if (!s) {
                s = new Set<number>();
                probesByAnchor.set(aid, s);
            }
            s.add(pIdx);
        };

        if (probeComposition === "intersection" && probes.length > 1) {
            const counts = new Map<ClaimId, Set<number>>();
            perProbe.forEach((pp, pIdx) => {
                for (const aid of pp.ranked) {
                    let s = counts.get(aid);
                    if (!s) {
                        s = new Set<number>();
                        counts.set(aid, s);
                    }
                    s.add(pIdx);
                }
            });
            const minProbes = Math.ceil(probes.length / 2);
            for (const [aid, hitProbes] of counts) {
                if (hitProbes.size >= minProbes) {
                    for (const pIdx of hitProbes) remember(aid, pIdx);
                }
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // No claim cleared the intersection threshold — fall back to union
            // so we don't return an empty result on every multi-probe query.
        }

        if (probeComposition === "weighted-fusion" && probes.length > 1) {
            const tau = args.weightedFusionTau;
            const aggregate = new Map<ClaimId, number>();
            const probesAboveTau = new Map<ClaimId, Set<number>>();
            for (const claim of validClaims) {
                let agg = 0;
                const above = new Set<number>();
                perProbe.forEach((pp, pIdx) => {
                    const cos = pp.cosineByAnchor.get(claim.id) ?? 0;
                    const contribution = Math.max(0, cos - tau);
                    if (contribution > 0) {
                        agg += contribution;
                        above.add(pIdx);
                    }
                });
                if (agg > 0) {
                    aggregate.set(claim.id, agg);
                    probesAboveTau.set(claim.id, above);
                }
            }
            const ranked = Array.from(aggregate.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, anchorTopK)
                .map(([id]) => id);
            for (const aid of ranked) {
                const above = probesAboveTau.get(aid);
                if (!above || above.size === 0) {
                    // Defensive: include the anchor without probe attribution
                    // rather than dropping a high-aggregate node entirely.
                    remember(aid, 0);
                    continue;
                }
                for (const pIdx of above) remember(aid, pIdx);
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // Fall through to union if fusion produced nothing.
        }

        // Default: union of per-probe top-K.
        perProbe.forEach((pp, pIdx) => {
            for (const aid of pp.ranked) remember(aid, pIdx);
        });
        return probesByAnchor;
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
        const decayOn = this.graph.temporalDecayEnabled();

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

                let edgeCost: number;
                if (e.type === "temporal") {
                    // Phase 1.6 A1: when temporal decay is on the graph, scale the hop
                    // cost by (1 − weight) so close-in-time adjacency is cheap and
                    // distant adjacency approaches `temporalHopCost`. Without decay,
                    // weights are uniform 1; fall back to the flat Phase-1.5 cost.
                    edgeCost = decayOn
                        ? temporalHopCost * Math.max(0, 1 - e.weight)
                        : temporalHopCost;
                } else {
                    edgeCost = Math.max(0, 1 - e.weight);
                }
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
