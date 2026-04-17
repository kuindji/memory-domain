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
    | { kind: "min-cosine-gate"; tau: number; useSessionWeights?: boolean };

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
    weights?: {
        probeCoverage?: number;
        edgeTypeDiversity?: number;
        recency?: number;
        pathQuality?: number;
        lengthPenalty?: number;
    };
};
