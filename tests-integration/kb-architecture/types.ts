export interface DatasetEntry {
    id: string;
    content: string;
    presetClassification?: string;
    expectedClassification: string;
    supersessionGroup?: string;
    relatedGroup?: string;
}

export interface VerificationQuestion {
    id: string;
    question: string;
    expectedAnswer: string;
    requiredEntryIds: string[];
    excludedEntryIds: string[];
    difficulty: "easy" | "medium" | "hard";
}

export interface Dataset {
    entries: DatasetEntry[];
    questions: VerificationQuestion[];
}

export interface PipelineStages {
    classify: boolean;
    tagAssign: boolean;
    topicLink: boolean;
    supersede: boolean;
    relateKnowledge: boolean;
}

export interface ArchitectureConfig {
    name: string;
    pipeline: PipelineStages;
    search: {
        mode: "vector" | "fulltext" | "hybrid";
        weights: { vector: number; fulltext: number; graph: number };
    };
    consolidate: boolean;
    contextBudget: number;
}

export interface Checkpoint<T = unknown> {
    phase: number;
    config: string;
    timestamp: string;
    durationMs: number;
    status: "success" | "failed" | "stopped";
    failReason?: string;
    data: T;
}

export interface IngestedData {
    memoryIdMap: Record<string, string>;
    entryCount: number;
}

export interface ProcessedEntry {
    datasetId: string;
    memoryId: string;
    assignedClassification: string;
    expectedClassification: string;
    supersessionEdges: string[];
    relatedEdges: string[];
}

export interface ProcessedData {
    entries: ProcessedEntry[];
    stageTiming: Record<string, number>;
    classificationAccuracy: number;
}

export interface ConsolidatedData {
    clustersFound: number;
    mergesPerformed: number;
    durationMs: number;
}

export interface EvaluationEntry {
    questionId: string;
    question: string;
    expectedAnswer: string;
    difficulty: string;
    context: string;
    answer: string;
    memoriesReturned: string[];
    requiredEntryIds: string[];
    excludedEntryIds: string[];
    buildContextMs: number;
    askMs: number;
}

export interface EvaluationData {
    entries: EvaluationEntry[];
    avgBuildContextMs: number;
    avgAskMs: number;
}

export interface ScoreEntry {
    questionId: string;
    score: number;
    reasoning: string;
    contextRelevance: number;
    contextNoise: number;
    supersessionCorrect: boolean;
}

export interface ScoresData {
    entries: ScoreEntry[];
    avgScore: number;
    avgTime: number;
    qualityPerSecond: number;
    contextRelevance: number;
    contextNoise: number;
    supersessionAccuracy: number;
    classificationAccuracy: number;
}

export interface ReportRow {
    config: string;
    avgScore: number;
    avgTime: number;
    qualityPerSecond: number;
    contextRelevance: number;
    contextNoise: number;
    supersessionAccuracy: number;
    classificationAccuracy: number;
    ingestTimeMs: number;
}

export interface ReportData {
    baseline: ReportRow;
    configs: ReportRow[];
    recommendations: string[];
}
