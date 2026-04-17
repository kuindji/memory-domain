import { cosineSimilarity } from "../../../src/core/scoring.js";
import {
    fitKMeans,
    membershipSimilarity,
    softMembership,
    type SoftClusterMembership,
} from "./clusters.js";
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
    probeComposition: "weighted-fusion" as ProbeComposition,
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
        const accessTracking = options.accessTracking ?? false;
        const weights = { ...DEFAULTS.weights, ...options.weights };

        const isValid = makeValidityFilter(mode);
        const validClaims = this.graph
            .nodeIds()
            .map((id) => this.graph.getNode(id))
            .filter((c): c is Claim => c !== undefined && isValid(c));

        const probeWeights = computeProbeWeights(probes, options.sessionDecayTau);
        const totalProbeWeight = probeWeights.reduce((s, w) => s + w, 0);

        const probesByAnchor = this.composeAnchors({
            probes,
            probeWeights,
            totalProbeWeight,
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
                    ? this.shortestCostPaths(
                          allAnchors[i],
                          bfsMaxDepth,
                          isValid,
                          temporalHopCost,
                          accessTracking,
                      )
                    : this.bfsShortestPaths(allAnchors[i], bfsMaxDepth, isValid, accessTracking);
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
        const scored: ScoredPath[] = [];

        for (const path of candidatePaths.values()) {
            const breakdown = this.scorePath(
                path,
                probesByAnchor,
                probeWeights,
                totalProbeWeight,
                now,
                bfsMaxDepth,
            );
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
        probeWeights: number[];
        totalProbeWeight: number;
        validClaims: Claim[];
        anchorTopK: number;
        anchorScoring: AnchorScoring;
        probeComposition: ProbeComposition;
        weightedFusionTau: number;
    }): Map<ClaimId, Set<number>> {
        const {
            probes,
            probeWeights,
            totalProbeWeight,
            validClaims,
            anchorTopK,
            anchorScoring,
            probeComposition,
        } = args;

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

        // Option J (Phase 2.3): density-coverage-bonus. Same per-probe
        // aggregate as Option I but multiplied by `k^(exponent - 1)`, where
        // `k` is the number of probes whose cosine clears `tau`. Designed
        // to flip the ranking when one strong probe (`k=1`, large raw)
        // would otherwise outscore many moderate probes (`k>1`, smaller
        // raws). At `exponent = 1` the bonus is `1` and the formula
        // collapses to Option I exactly. Defensive fall-through to union
        // when `tau` excludes everything matches Option I's pattern.
        if (anchorScoring.kind === "density-coverage-bonus") {
            const tau = anchorScoring.tau;
            const exponent = anchorScoring.exponent;
            const useWeights = anchorScoring.useSessionWeights ?? true;
            const aggregate = new Map<ClaimId, number>();
            const probesAboveTau = new Map<ClaimId, Set<number>>();
            for (const claim of validClaims) {
                let agg = 0;
                let k = 0;
                const above = new Set<number>();
                perProbe.forEach((pp, pIdx) => {
                    const cos = pp.cosineByAnchor.get(claim.id) ?? 0;
                    const raw = Math.max(0, cos - tau);
                    if (raw > 0) {
                        const w = useWeights ? probeWeights[pIdx] : 1;
                        agg += w * raw;
                        k += 1;
                        above.add(pIdx);
                    }
                });
                if (agg > 0 && k > 0) {
                    const score = agg * Math.pow(k, exponent - 1);
                    aggregate.set(claim.id, score);
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
                    remember(aid, 0);
                    continue;
                }
                for (const pIdx of above) remember(aid, pIdx);
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // Fall through to the union path if τ excluded everything.
        }

        // Option J (Phase 2.3): min-cosine-gate. Hard k=P gate — only
        // claims that clear `tau` against EVERY probe contribute. Score is
        // the minimum per-probe weighted contribution (the strict-AND
        // analogue of intersection retrieval); ties break by sum so the
        // ordering is total. Single-probe input degenerates to a cosine-
        // with-floor anchor scorer. Defensive fall-through to union when
        // no claim passes the gate (common at tier-2 with broad probes).
        if (anchorScoring.kind === "min-cosine-gate") {
            const tau = anchorScoring.tau;
            const useWeights = anchorScoring.useSessionWeights ?? true;
            const aggregate = new Map<ClaimId, number>();
            const probesAboveTau = new Map<ClaimId, Set<number>>();
            for (const claim of validClaims) {
                let mn = Infinity;
                let sumAgg = 0;
                let above = 0;
                const aboveSet = new Set<number>();
                for (let pIdx = 0; pIdx < perProbe.length; pIdx++) {
                    const cos = perProbe[pIdx].cosineByAnchor.get(claim.id) ?? 0;
                    const raw = Math.max(0, cos - tau);
                    if (raw <= 0) {
                        mn = 0;
                        break;
                    }
                    const w = useWeights ? probeWeights[pIdx] : 1;
                    const term = w * raw;
                    if (term < mn) mn = term;
                    sumAgg += term;
                    above += 1;
                    aboveSet.add(pIdx);
                }
                if (above === perProbe.length && mn > 0) {
                    aggregate.set(claim.id, mn + 1e-6 * sumAgg);
                    probesAboveTau.set(claim.id, aboveSet);
                }
            }
            const ranked = Array.from(aggregate.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, anchorTopK)
                .map(([id]) => id);
            for (const aid of ranked) {
                const above = probesAboveTau.get(aid);
                if (!above || above.size === 0) {
                    remember(aid, 0);
                    continue;
                }
                for (const pIdx of above) remember(aid, pIdx);
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // Fall through to the union path if no claim cleared the gate.
        }

        // Option H (Phase 2.4): cluster-affinity-boost anchor scoring. Base
        // aggregate is the Phase-2.1 weighted-fusion density
        // `Σ w(p)·max(0, cos(p, c) − τ)`; on top we multiply by
        // `(1 + β · max_p cos(probeClusters(p), claimClusters(c)))` where
        // the cluster distributions come from a seeded soft k-means over
        // the valid-claim embedding set. Intent: cross-cluster bridge
        // claims (e.g. Aristotle tutoring Alexander — spans phil_ and
        // alex_) get boosted iff the probe set itself spans the relevant
        // clusters. Multiplicative form means `agg = 0` claims stay out,
        // so this acts as a re-ranker over the Option I candidate set.
        // `beta = 0` collapses to Option I exactly. Defensive fall-through
        // to union when τ excludes everything, matching I/J behaviour.
        if (anchorScoring.kind === "cluster-affinity-boost") {
            const tau = anchorScoring.tau;
            const beta = anchorScoring.beta;
            const useWeights = anchorScoring.useSessionWeights ?? true;
            const temperature = anchorScoring.temperature;
            const seed = anchorScoring.seed ?? 1;
            const k = Math.min(anchorScoring.k, validClaims.length);

            const claimMembership = new Map<ClaimId, SoftClusterMembership>();
            let probeMembership: SoftClusterMembership[] = [];
            if (beta > 0 && k > 0 && validClaims.length > 0) {
                const model = fitKMeans(
                    validClaims.map((c) => c.embedding),
                    k,
                    { seed, similarity: this.similarity },
                );
                for (const c of validClaims) {
                    claimMembership.set(
                        c.id,
                        softMembership(c.embedding, model, temperature, this.similarity),
                    );
                }
                probeMembership = probes.map((p) =>
                    softMembership(p.embedding, model, temperature, this.similarity),
                );
            }

            const aggregate = new Map<ClaimId, number>();
            const probesAboveTau = new Map<ClaimId, Set<number>>();
            for (const claim of validClaims) {
                let agg = 0;
                const above = new Set<number>();
                perProbe.forEach((pp, pIdx) => {
                    const cos = pp.cosineByAnchor.get(claim.id) ?? 0;
                    const raw = Math.max(0, cos - tau);
                    if (raw > 0) {
                        const w = useWeights ? probeWeights[pIdx] : 1;
                        agg += w * raw;
                        above.add(pIdx);
                    }
                });
                if (agg > 0) {
                    let boost = 0;
                    if (beta > 0 && probeMembership.length > 0) {
                        const cm = claimMembership.get(claim.id);
                        if (cm) {
                            for (let pIdx = 0; pIdx < probeMembership.length; pIdx++) {
                                const s = membershipSimilarity(probeMembership[pIdx], cm);
                                if (s > boost) boost = s;
                            }
                        }
                    }
                    aggregate.set(claim.id, agg * (1 + beta * boost));
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
                    remember(aid, 0);
                    continue;
                }
                for (const pIdx of above) remember(aid, pIdx);
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // Fall through to union if τ excluded everything.
        }

        // Option I (Phase 2.2): weighted-probe-density anchor scoring. When
        // active, bypass per-probe top-K and rank every valid claim by
        // `sum_p w(p) · max(0, cos(p, c) - tau)` — the same aggregate that
        // A3 weighted-fusion computes in probeComposition, but promoted to
        // the anchor-selection slot so its `tau` and session-weight toggle
        // tune independently of probeComposition. Composition is effectively
        // a no-op on the resulting anchor set (density already fuses).
        if (anchorScoring.kind === "weighted-probe-density") {
            const tau = anchorScoring.tau;
            const useWeights = anchorScoring.useSessionWeights ?? true;
            const aggregate = new Map<ClaimId, number>();
            const probesAboveTau = new Map<ClaimId, Set<number>>();
            for (const claim of validClaims) {
                let agg = 0;
                const above = new Set<number>();
                perProbe.forEach((pp, pIdx) => {
                    const cos = pp.cosineByAnchor.get(claim.id) ?? 0;
                    const raw = Math.max(0, cos - tau);
                    if (raw > 0) {
                        const w = useWeights ? probeWeights[pIdx] : 1;
                        agg += w * raw;
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
                    remember(aid, 0);
                    continue;
                }
                for (const pIdx of above) remember(aid, pIdx);
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // Fall through to the default union path if τ excluded everything.
        }

        // Option M (Phase 2.6): idf-weighted-fusion anchor scoring. Same
        // weighted-fusion aggregate as Option I but multiplied by
        // `(1 + α · normIdf(c))`, where `normIdf(c) = nodeIdfMass(c) /
        // maxNodeIdf` over valid claims. Targets the tier-2 vocabulary-
        // distractor failure mode (claims like `pw_pausanias_commands`
        // that match the generic token "generals" but lack specific-kingdom
        // IDF mass). A2 `cosine-idf-mass` already does this for the per-
        // probe top-K path, but that path is bypassed whenever a fusion-
        // style anchor scorer is selected (Option I / J / H) or when
        // probeComposition = weighted-fusion is used over raw cosine.
        // At α=0 this collapses to Option I byte-for-byte — used as the
        // isolation row.
        if (anchorScoring.kind === "idf-weighted-fusion") {
            const tau = anchorScoring.tau;
            const alpha = anchorScoring.alpha;
            const useWeights = anchorScoring.useSessionWeights ?? true;
            let maxNodeIdf = 0;
            for (const c of validClaims) {
                const m = this.graph.nodeIdfMass(c.id);
                if (m > maxNodeIdf) maxNodeIdf = m;
            }
            const aggregate = new Map<ClaimId, number>();
            const probesAboveTau = new Map<ClaimId, Set<number>>();
            for (const claim of validClaims) {
                let agg = 0;
                const above = new Set<number>();
                perProbe.forEach((pp, pIdx) => {
                    const cos = pp.cosineByAnchor.get(claim.id) ?? 0;
                    const raw = Math.max(0, cos - tau);
                    if (raw > 0) {
                        const w = useWeights ? probeWeights[pIdx] : 1;
                        agg += w * raw;
                        above.add(pIdx);
                    }
                });
                if (agg > 0) {
                    const norm = maxNodeIdf > 0 ? this.graph.nodeIdfMass(claim.id) / maxNodeIdf : 0;
                    const score = agg * (1 + alpha * norm);
                    aggregate.set(claim.id, score);
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
                    remember(aid, 0);
                    continue;
                }
                for (const pIdx of above) remember(aid, pIdx);
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // Fall through to the default union path if τ excluded everything.
        }

        // Option O (Phase 2.10): SYNAPSE-inspired spreading activation. Seed
        // activation from the union of per-probe weighted-cosine top-K
        // (`initialTopK`), propagate over `GraphIndex.neighbors` for
        // `maxHops` iterations with fan-effect dilution `/ fan(j)` and
        // non-symmetric top-`inhibitionTopM` lateral inhibition each hop,
        // then re-rank by final activation. Targets the tier-2 vocabulary-
        // distractor and within-cluster-granularity failure modes.
        // Defensive fall-through to union when seeding produces nothing
        // (matches the I/J/H/M pattern). See `notes/phase-2.10-reading.md`.
        if (anchorScoring.kind === "spreading-activation") {
            const ranked = this.spreadingActivationRank({
                perProbe,
                probeWeights,
                validClaims,
                anchorTopK,
                scoring: anchorScoring,
            });
            for (const { id, attribution } of ranked) {
                if (attribution.size === 0) {
                    remember(id, 0);
                    continue;
                }
                for (const pIdx of attribution) remember(id, pIdx);
            }
            if (probesByAnchor.size > 0) return probesByAnchor;
            // Fall through to union if seeding produced nothing.
        }

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
            // Threshold is half the total probe weight; with uniform weights this
            // matches the prior `>= ceil(P/2)` count rule. With session decay it
            // lets a hit by late-turn (high-weight) probes pass even when fewer
            // probes are involved.
            const threshold = 0.5 * totalProbeWeight;
            for (const [aid, hitProbes] of counts) {
                let voteWeight = 0;
                for (const pIdx of hitProbes) voteWeight += probeWeights[pIdx];
                if (voteWeight >= threshold) {
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
                    const raw = Math.max(0, cos - tau);
                    if (raw > 0) {
                        agg += probeWeights[pIdx] * raw;
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

    /**
     * Phase 2.10 Option O — SYNAPSE-style spreading activation reranker.
     *
     * Pipeline:
     *  1. Seed: union of per-probe weighted-cosine top-`initialTopK`. Initial
     *     activation per node = Σ_p w(p) · cos(p, node), summed across the
     *     probes that selected it.
     *  2. Propagate for `maxHops` iterations:
     *       u_i(t) = (1 − decay) · a_i(t−1)
     *              + Σ_{j: j→i} spreadingFactor · w_ji · a_j(t−1) / fan(j)
     *     Edge weights come from `Edge.weight`; temporal already carries
     *     `exp(−Δt/τ)` when `temporalDecayTau` is on.
     *  3. Lateral inhibition (per hop, before committing): take top-M
     *     by activation; suppress
     *       û_i = max(0, u_i − inhibitionStrength · Σ_{k: u_k > u_i} (u_k − u_i))
     *     Non-symmetric — only stronger nodes inhibit weaker.
     *  4. Read out: sort by final activation, take top `anchorTopK` with
     *     activation > 0.
     *
     * Probe attribution: seeded nodes carry the seeding probes; nodes
     * activated only via propagation carry probe 0 (defensive default
     * matching the I/J/H/M fall-through pattern). Per-probe activation
     * channels are a future refinement.
     */
    private spreadingActivationRank(args: {
        perProbe: Array<{ ranked: ClaimId[]; cosineByAnchor: Map<ClaimId, number> }>;
        probeWeights: number[];
        validClaims: Claim[];
        anchorTopK: number;
        scoring: Extract<AnchorScoring, { kind: "spreading-activation" }>;
    }): Array<{ id: ClaimId; attribution: Set<number> }> {
        const { perProbe, probeWeights, validClaims, anchorTopK, scoring } = args;
        const useWeights = scoring.useSessionWeights ?? true;

        // 1. Seed activation + attribution from per-probe top-K union.
        const activation = new Map<ClaimId, number>();
        const attribution = new Map<ClaimId, Set<number>>();
        perProbe.forEach((pp, pIdx) => {
            const w = useWeights ? probeWeights[pIdx] : 1;
            for (const aid of pp.ranked) {
                const cos = pp.cosineByAnchor.get(aid) ?? 0;
                if (cos <= 0) continue;
                activation.set(aid, (activation.get(aid) ?? 0) + w * cos);
                let s = attribution.get(aid);
                if (!s) {
                    s = new Set<number>();
                    attribution.set(aid, s);
                }
                s.add(pIdx);
            }
        });

        if (activation.size === 0) return [];

        // 2. Propagate. We only consider valid claims (mode filter already
        //    applied upstream). Cache fan-out per source on demand.
        const validIds = new Set(validClaims.map((c) => c.id));
        const fanCache = new Map<ClaimId, number>();
        const fanOf = (id: ClaimId): number => {
            const cached = fanCache.get(id);
            if (cached !== undefined) return cached;
            const f = this.graph.neighbors(id).length;
            fanCache.set(id, f);
            return f;
        };

        for (let hop = 0; hop < scoring.maxHops; hop++) {
            const next = new Map<ClaimId, number>();

            // Retention term: (1 − decay) · a_i(t−1)
            const retention = 1 - scoring.decay;
            for (const [id, a] of activation) {
                if (retention > 0) next.set(id, retention * a);
            }

            // Spread term: each currently-activated node distributes to its
            // neighbors. We propagate from `activation` (last hop's state),
            // accumulating into `next`.
            for (const [srcId, srcAct] of activation) {
                if (srcAct <= 0) continue;
                const fan = fanOf(srcId);
                if (fan <= 0) continue;
                const share = (scoring.spreadingFactor * srcAct) / fan;
                for (const edge of this.graph.neighbors(srcId)) {
                    if (!validIds.has(edge.to)) continue;
                    const incoming = share * edge.weight;
                    if (incoming === 0) continue;
                    next.set(edge.to, (next.get(edge.to) ?? 0) + incoming);
                }
            }

            // 3. Lateral inhibition over top-M by current activation.
            applyLateralInhibition(next, scoring.inhibitionTopM, scoring.inhibitionStrength);

            // Drop zeros to keep the active set bounded.
            for (const [id, a] of next) {
                if (a <= 0) next.delete(id);
            }

            activation.clear();
            for (const [id, a] of next) activation.set(id, a);
        }

        // 4. Read out: top-K by activation. Defensive — also clamp by
        //    valid-claim membership in case anything slipped through.
        const ranked = Array.from(activation.entries())
            .filter(([id, a]) => a > 0 && validIds.has(id))
            .sort((a, b) => b[1] - a[1])
            .slice(0, anchorTopK);

        return ranked.map(([id]) => ({
            id,
            attribution: attribution.get(id) ?? new Set<number>(),
        }));
    }

    private bfsShortestPaths(
        start: ClaimId,
        maxDepth: number,
        isValid: (c: Claim) => boolean,
        accessTracking: boolean,
    ): Map<ClaimId, Path> {
        const result = new Map<ClaimId, Path>();
        type QItem = { id: ClaimId; depth: number; nodes: ClaimId[]; edges: Edge[] };
        const visited = new Set<ClaimId>([start]);
        const queue: QItem[] = [{ id: start, depth: 0, nodes: [start], edges: [] }];
        let head = 0;

        while (head < queue.length) {
            const cur = queue[head++];
            if (accessTracking) this.graph.bumpNode(cur.id);
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
                if (accessTracking) this.graph.bumpEdge(e.from, e.to, e.type);
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
        accessTracking: boolean,
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

            if (accessTracking) this.graph.bumpNode(cur.id);

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
                if (accessTracking) this.graph.bumpEdge(e.from, e.to, e.type);
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
        probeWeights: number[],
        totalProbeWeight: number,
        now: Timestamp,
        maxDepth: number,
    ): ScoreBreakdown {
        const coveredProbes = new Set<number>();
        for (const nid of path.nodeIds) {
            const p = probesByAnchor.get(nid);
            if (p) for (const idx of p) coveredProbes.add(idx);
        }
        let coveredWeight = 0;
        for (const idx of coveredProbes) coveredWeight += probeWeights[idx];
        const probeCoverage = totalProbeWeight > 0 ? coveredWeight / totalProbeWeight : 0;

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

/**
 * Phase 2.10 — non-symmetric top-M lateral inhibition (SYNAPSE Eq. 3).
 *
 * Mutates `field` in place. For each node `i` in the top-M set by current
 * activation, subtract `strength · Σ_{k: u_k > u_i} (u_k − u_i)` and clamp
 * to zero. Outside-top-M nodes are untouched. Suppression flows only from
 * stronger to weaker, so the top-1 node is never inhibited.
 *
 * Cost is O(M²) per call — bounded by the configured `topM`, not by the
 * size of the activation field.
 */
function applyLateralInhibition(field: Map<ClaimId, number>, topM: number, strength: number): void {
    if (strength <= 0 || topM <= 0 || field.size === 0) return;

    const top = Array.from(field.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topM);

    const updates = new Map<ClaimId, number>();
    for (let i = 0; i < top.length; i++) {
        const [id, u] = top[i];
        let suppression = 0;
        for (let k = 0; k < top.length; k++) {
            if (k === i) continue;
            const uk = top[k][1];
            if (uk > u) suppression += uk - u;
        }
        updates.set(id, Math.max(0, u - strength * suppression));
    }
    for (const [id, v] of updates) field.set(id, v);
}

/**
 * Per-probe weights for session-mode multi-turn retrieval.
 *
 * When `sessionDecayTau` is undefined or no probe carries a `turnIndex`,
 * every probe contributes equally (weight 1.0) — matching pre-Phase-2.1
 * behavior. Otherwise weights follow `exp(-(maxTurn - turnIndex) / tau)`
 * relative to the latest observed turn, so later-turn probes outweigh
 * earlier-turn probes. Probes without a turnIndex are treated as belonging
 * to the latest turn (weight 1.0), which matches one-shot
 * `PathMemory.queryWithProbes` callers that never set the field.
 */
function computeProbeWeights(probes: Probe[], sessionDecayTau?: number): number[] {
    if (sessionDecayTau === undefined || sessionDecayTau <= 0) {
        return probes.map(() => 1);
    }
    let maxTurn = -Infinity;
    for (const p of probes) {
        if (p.turnIndex !== undefined && p.turnIndex > maxTurn) maxTurn = p.turnIndex;
    }
    if (!Number.isFinite(maxTurn)) return probes.map(() => 1);
    return probes.map((p) => {
        const t = p.turnIndex ?? maxTurn;
        return Math.exp(-(maxTurn - t) / sessionDecayTau);
    });
}
