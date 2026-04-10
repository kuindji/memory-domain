export interface UserDomainOptions {
    consolidateSchedule?: {
        enabled?: boolean;
        intervalMs?: number;
    };
}

export type UserFactClassification =
    | "identity"
    | "preference"
    | "expertise"
    | "goal"
    | "relationship"
    | "habit"
    | "other";

export interface UserAttributes {
    classification?: UserFactClassification;
    userId?: string;
    superseded?: boolean;
    validFrom?: number;
    validUntil?: number;
    confidence?: number;
    importance?: number;
    accessCount?: number;
    lastAccessedAt?: number;
    answersQuestion?: string;
    source?: string;
}

export const DEFAULT_USER_IMPORTANCE: Record<UserFactClassification, number> = {
    identity: 1.0,
    preference: 0.8,
    expertise: 0.8,
    goal: 0.9,
    relationship: 0.7,
    habit: 0.6,
    other: 0.5,
};

export const USER_DOMAIN_ID = "user";
export const USER_TAG = "user";
export const DEFAULT_CONSOLIDATE_INTERVAL_MS = 3_600_000;
