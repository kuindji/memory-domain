export type ChatLayer = "working" | "episodic" | "semantic";
export type ChatRole = "user" | "assistant";

export interface ChatAttributes {
    role: ChatRole;
    layer: ChatLayer;
    chatSessionId: string;
    userId: string;
    messageIndex: number;
    weight?: number;
    validFrom?: number;
    invalidAt?: number;
}

export interface ChatDomainOptions {
    id?: string;
    workingMemoryCapacity?: number;
    workingMemoryMaxAge?: number;
    promoteSchedule?: {
        enabled?: boolean;
        intervalMs?: number;
    };
    consolidateSchedule?: {
        enabled?: boolean;
        intervalMs?: number;
    };
    pruneSchedule?: {
        enabled?: boolean;
        intervalMs?: number;
    };
    decay?: {
        episodicLambda?: number;
        semanticLambda?: number;
        pruneThreshold?: number;
    };
    consolidation?: {
        similarityThreshold?: number;
        minClusterSize?: number;
        semanticDedupThreshold?: number;
    };
}

export const CHAT_DOMAIN_ID = "chat";
export const CHAT_TAG = "chat";
export const CHAT_MESSAGE_TAG = "chat/message";
export const CHAT_EPISODIC_TAG = "chat/episodic";
export const CHAT_SEMANTIC_TAG = "chat/semantic";

export const DEFAULT_WORKING_CAPACITY = 50;
export const DEFAULT_WORKING_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_PROMOTE_INTERVAL_MS = 1_800_000; // 30 minutes
export const DEFAULT_CONSOLIDATE_INTERVAL_MS = 3_600_000; // 1 hour
export const DEFAULT_PRUNE_INTERVAL_MS = 3_600_000; // 1 hour
export const DEFAULT_EPISODIC_LAMBDA = 0.01;
export const DEFAULT_SEMANTIC_LAMBDA = 0.001;
export const DEFAULT_PRUNE_THRESHOLD = 0.05;
export const DEFAULT_CONSOLIDATION_SIMILARITY = 0.7;
export const DEFAULT_CONSOLIDATION_MIN_CLUSTER = 3;
export const DEFAULT_SEMANTIC_DEDUP_THRESHOLD = 0.85;
