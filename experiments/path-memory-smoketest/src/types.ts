export type ClaimId = string;
export type Timestamp = number;

export type Claim = {
    id: ClaimId;
    text: string;
    embedding: number[];
    tokens: string[];
    validFrom: Timestamp;
    validUntil: Timestamp;
    supersedes?: ClaimId;
};

export type EdgeType = "temporal" | "lexical" | "semantic";

export type EdgeMeta = {
    sharedTokens?: string[];
    unionTokens?: string[];
    similarity?: number;
    deltaT?: number;
};

export type Edge = {
    type: EdgeType;
    from: ClaimId;
    to: ClaimId;
    weight: number;
    meta?: EdgeMeta;
};

export type HistoryEvent =
    | { kind: "ingest"; claim: Claim; at: Timestamp }
    | { kind: "supersede"; oldId: ClaimId; newId: ClaimId; at: Timestamp };

export type Probe = {
    text: string;
    embedding: number[];
    turnIndex?: number;
};

export type Path = {
    nodeIds: ClaimId[];
    edges: Edge[];
};

export type ScoreBreakdown = {
    probeCoverage: number;
    edgeTypeDiversity: number;
    recency: number;
    pathQuality: number;
    lengthPenalty: number;
};

export type ScoredPath = {
    path: Path;
    score: number;
    breakdown: ScoreBreakdown;
};

export type RetrievalMode = "current" | { kind: "asOf"; at: Timestamp };

export type TraversalMode = "bfs" | "dijkstra";

export type AnchorScoring =
    | { kind: "cosine" }
    | { kind: "cosine-idf-mass"; alpha: number }
    | { kind: "weighted-probe-density"; tau: number; useSessionWeights?: boolean }
    | {
          kind: "density-coverage-bonus";
          tau: number;
          exponent: number;
          useSessionWeights?: boolean;
      }
    | { kind: "min-cosine-gate"; tau: number; useSessionWeights?: boolean }
    | {
          kind: "cluster-affinity-boost";
          tau: number;
          beta: number;
          k: number;
          temperature?: number;
          useSessionWeights?: boolean;
          seed?: number;
      }
    | {
          kind: "idf-weighted-fusion";
          tau: number;
          alpha: number;
          useSessionWeights?: boolean;
      }
    | {
          /**
           * Phase 2.10 Option O — SYNAPSE-inspired spreading activation.
           *
           * Seed activation per-probe via weighted cosine, propagate over
           * `GraphIndex.neighbors` for `maxHops` iterations with fan-effect
           * dilution (`/ neighbors(j).length`), apply non-symmetric
           * top-`inhibitionTopM` lateral inhibition each hop (only stronger
           * nodes suppress weaker), then re-rank the anchor set by final
           * activation. Paper defaults: maxHops=3, decay=0.5, spreadingFactor=0.8,
           * inhibitionTopM=7, inhibitionStrength=0.15. See SYNAPSE
           * (arXiv:2601.02744v2) and `notes/phase-2.10-reading.md`.
           */
          kind: "spreading-activation";
          initialTopK: number;
          maxHops: number;
          decay: number;
          spreadingFactor: number;
          inhibitionTopM: number;
          inhibitionStrength: number;
          useSessionWeights?: boolean;
      };

export type ProbeComposition = "union" | "intersection" | "weighted-fusion";

export type RetrievalOptions = {
    mode?: RetrievalMode;
    anchorTopK?: number;
    bfsMaxDepth?: number;
    resultTopN?: number;
    traversal?: TraversalMode;
    temporalHopCost?: number;
    anchorScoring?: AnchorScoring;
    probeComposition?: ProbeComposition;
    weightedFusionTau?: number;
    sessionDecayTau?: number;
    /**
     * Phase 3 — when true, traversal loops bump per-node and per-edge
     * read counters on the underlying `GraphIndex`. Observability-only;
     * counters are not consumed by any scoring path. Default: false.
     */
    accessTracking?: boolean;
    weights?: {
        probeCoverage?: number;
        edgeTypeDiversity?: number;
        recency?: number;
        pathQuality?: number;
        lengthPenalty?: number;
    };
};
