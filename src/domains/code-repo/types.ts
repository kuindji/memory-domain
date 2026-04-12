export type MemoryClassification =
    | "decision"
    | "rationale"
    | "clarification"
    | "direction"
    | "observation"
    | "question";

export type Audience = "technical" | "business";

export type ModuleKind = "package" | "service" | "lambda" | "subsystem" | "library";

export interface CodeRepoAttributes {
    classification: MemoryClassification;
    audience: Audience[];
    superseded: boolean;
    validFrom?: number;
    validUntil?: number;
    decomposed?: boolean;
    parentMemoryId?: string;
    answersQuestion?: string;
    importance?: number;
    accessCount?: number;
    lastAccessedAt?: number;
    confidence?: number;
    source?: string;
}

export const DEFAULT_IMPORTANCE: Record<MemoryClassification, number> = {
    decision: 1.0,
    rationale: 0.9,
    direction: 0.9,
    clarification: 0.7,
    observation: 0.5,
    question: 0.4,
};

export const DECOMPOSITION_TOKEN_THRESHOLD = 200;
export const MAX_ATOMIC_FACTS = 10;

export interface CodeRepoDomainOptions {
    id?: string;
    projectRoot?: string;
    commitScanner?: {
        enabled?: boolean;
        intervalMs?: number;
    };
    driftDetector?: {
        enabled?: boolean;
        intervalMs?: number;
    };
}

// SurrealDB parses record IDs like `domain:code-repo` as the expression
// `domain:code - repo`, silently truncating the hyphen-prefixed portion. This
// breaks owned_by / tag lookups for any domain ID or unescaped tag label
// containing a hyphen (see isMemoryVisible in core/engine.ts, which compares
// stored IDs by string prefix). We use underscores here instead. Nested tags
// (with "/") are backtick-escaped by ensureTag, but the parent tag is not —
// so the entire namespace uses underscores for consistency.
export const CODE_REPO_DOMAIN_ID = "code_repo";
export const CODE_REPO_TAG = "code_repo";
export const CODE_REPO_TECHNICAL_TAG = "code_repo/technical";
export const CODE_REPO_BUSINESS_TAG = "code_repo/business";
export const CODE_REPO_DECISION_TAG = "code_repo/decision";
export const CODE_REPO_RATIONALE_TAG = "code_repo/rationale";
export const CODE_REPO_CLARIFICATION_TAG = "code_repo/clarification";
export const CODE_REPO_DIRECTION_TAG = "code_repo/direction";
export const CODE_REPO_OBSERVATION_TAG = "code_repo/observation";
export const CODE_REPO_QUESTION_TAG = "code_repo/question";

export const DEFAULT_SCAN_INTERVAL_MS = 3_600_000; // 1 hour
export const DEFAULT_DRIFT_INTERVAL_MS = 86_400_000; // 24 hours

export const CLASSIFICATION_TAGS: Record<MemoryClassification, string> = {
    decision: CODE_REPO_DECISION_TAG,
    rationale: CODE_REPO_RATIONALE_TAG,
    clarification: CODE_REPO_CLARIFICATION_TAG,
    direction: CODE_REPO_DIRECTION_TAG,
    observation: CODE_REPO_OBSERVATION_TAG,
    question: CODE_REPO_QUESTION_TAG,
};

export const AUDIENCE_TAGS: Record<Audience, string> = {
    technical: CODE_REPO_TECHNICAL_TAG,
    business: CODE_REPO_BUSINESS_TAG,
};

// --- Bootstrap types ---

export interface DirEntry {
    name: string;
    relativePath: string;
    isDirectory: boolean;
    children?: DirEntry[];
    files?: string[];
}

export interface TriageResult {
    repoSize?: string;
    filesToRead?: string[];
}

export interface AnalysisModule {
    name: string;
    path: string;
    kind: string;
    description?: string;
}

export interface AnalysisRelationship {
    from: string;
    to: string;
    type: string;
    description?: string;
}

export interface AnalysisResult {
    modules?: AnalysisModule[];
    data_entities?: Array<{ name: string; source?: string }>;
    concepts?: Array<{ name: string; description?: string }>;
    patterns?: Array<{ name: string; scope?: string }>;
    relationships?: AnalysisRelationship[];
}
