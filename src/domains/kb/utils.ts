import { StringRecordId } from "surrealdb";
import type { DomainContext, OwnedMemory } from "../../core/types.js";
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from "../topic/types.js";
import type { KbClassification, QueryIntent } from "./types.js";
import {
    CLASSIFICATION_TAGS,
    KB_DOMAIN_ID,
    DEFAULT_IMPORTANCE,
    MAX_ATOMIC_FACTS,
} from "./types.js";

const VALID_CLASSIFICATIONS = new Set<string>([
    "fact",
    "definition",
    "how-to",
    "reference",
    "concept",
    "insight",
]);

/**
 * Checks whether a KB entry is valid for retrieval.
 * Returns false if superseded or temporally expired.
 */
export function isEntryValid(attrs: Record<string, unknown> | undefined, now: number): boolean {
    if (!attrs) return true;
    if (attrs.superseded) return false;
    if (attrs.decomposed) return false;
    if (typeof attrs.validUntil === "number" && attrs.validUntil < now) return false;
    return true;
}

/**
 * Extracts KB domain attributes from a scored memory's domainAttributes map.
 */
export function getKbAttrs(
    domainAttributes: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
    return domainAttributes[KB_DOMAIN_ID] as Record<string, unknown> | undefined;
}

/**
 * Records an access event for a memory retrieved in buildContext.
 */
export async function recordAccess(
    context: DomainContext,
    memoryId: string,
    currentAttrs: Record<string, unknown> | undefined,
): Promise<void> {
    const accessCount = ((currentAttrs?.accessCount as number) ?? 0) + 1;
    await context.updateAttributes(memoryId, {
        ...currentAttrs,
        accessCount,
        lastAccessedAt: Date.now(),
    });
}

/**
 * Computes effective importance for a memory with time-based decay.
 */
export function computeImportance(
    attrs: Record<string, unknown> | undefined,
    decayFactor: number,
): number {
    const classification = (attrs?.classification as KbClassification) ?? "fact";
    const baseImportance = (attrs?.importance as number) ?? DEFAULT_IMPORTANCE[classification];
    const lastAccessed = attrs?.lastAccessedAt as number | undefined;
    if (!lastAccessed) return baseImportance;

    const daysSinceAccess = (Date.now() - lastAccessed) / (1000 * 60 * 60 * 24);
    return baseImportance * Math.pow(decayFactor, daysSinceAccess / 30);
}

const ATOMIC_DECOMPOSITION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            claim: {
                type: "string",
                description: "A single atomic fact or claim that stands on its own",
            },
            classification: {
                type: "string",
                enum: ["fact", "definition", "how-to", "reference", "concept", "insight"],
                description: "Best classification for this atomic claim",
            },
        },
        required: ["claim"],
    },
});

/**
 * Decomposes a long content string into atomic facts using LLM extraction.
 * Returns null if decomposition is not worthwhile (<=1 fact or extraction fails).
 */
export async function decomposeToAtomicFacts(
    content: string,
    context: DomainContext,
): Promise<Array<{ claim: string; classification?: KbClassification }> | null> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return null;

    try {
        const decompositionPrompt = await context.loadPrompt("decomposition");
        const results = (await llm.extractStructured(
            content,
            ATOMIC_DECOMPOSITION_SCHEMA,
            decompositionPrompt,
        )) as Array<{ claim: string; classification?: string }>;

        if (!Array.isArray(results) || results.length <= 1) return null;

        return results.slice(0, MAX_ATOMIC_FACTS).map((r) => ({
            claim: r.claim,
            classification: VALID_CLASSIFICATIONS.has(r.classification ?? "")
                ? (r.classification as KbClassification)
                : undefined,
        }));
    } catch {
        return null;
    }
}

function logKbWarning(scope: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[memory-domain warning] ${scope}: ${errorMessage}`);
}

/**
 * Ensures a tag node exists in the graph with the given label.
 */
export async function ensureTag(context: DomainContext, label: string): Promise<string> {
    const tagId = label.includes("/") ? `tag:\`${label}\`` : `tag:${label}`;
    try {
        await context.graph.createNodeWithId(tagId, { label, created_at: Date.now() });
    } catch {
        /* already exists */
    }
    return tagId;
}

/**
 * Maps a classification string to its corresponding tag path.
 */
export function classificationToTag(classification: KbClassification): string {
    return CLASSIFICATION_TAGS[classification];
}

const BATCH_TOPIC_EXTRACTION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            index: { type: "number", description: "Zero-based index of the item" },
            topics: {
                type: "array",
                items: { type: "string" },
                description: "Topic names extracted from this item",
            },
        },
        required: ["index", "topics"],
    },
});

/**
 * Batch extracts topics from multiple entries in a single LLM call,
 * then links each entry to its extracted topics.
 */
export async function linkToTopicsBatch(
    context: DomainContext,
    entries: OwnedMemory[],
): Promise<void> {
    const topicsMap = await batchExtractTopics(context, entries);

    for (const entry of entries) {
        const topicNames = topicsMap.get(entry.memory.id) ?? [];
        const validTopics: string[] = [];
        for (const topicName of topicNames) {
            const trimmed = topicName.trim();
            if (!trimmed) continue;
            await linkSingleTopic(context, entry.memory.id, trimmed);
            validTopics.push(trimmed);
        }

        // Denormalize topics onto memory record for DB-level filtering
        if (validTopics.length > 0) {
            try {
                await context.graph.query("UPDATE $memId SET topics = $topics", {
                    memId: new StringRecordId(entry.memory.id),
                    topics: validTopics,
                });
            } catch {
                /* best-effort denormalization */
            }
        }
    }
}

async function batchExtractTopics(
    context: DomainContext,
    entries: OwnedMemory[],
): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const llm = context.llmAt("low");
    const topicPrompt = await context.loadPrompt("topic-extraction");

    const numberedItems = entries.map((e, i) => `${i}. ${e.memory.content}`).join("\n\n");

    if (llm.extractStructured) {
        try {
            const raw = (await llm.extractStructured(
                numberedItems,
                BATCH_TOPIC_EXTRACTION_SCHEMA,
                topicPrompt,
            )) as Array<{ index: number; topics: string[] }>;

            for (const item of raw) {
                if (item.index >= 0 && item.index < entries.length && Array.isArray(item.topics)) {
                    result.set(entries[item.index].memory.id, item.topics);
                }
            }
            return result;
        } catch (error) {
            logKbWarning("kb.inbox.topicExtraction.extractStructured", error);
            // Fall through to sequential fallback
        }
    }

    // Fallback: sequential extract calls
    for (const entry of entries) {
        try {
            const topics = await llm.extract(entry.memory.content);
            result.set(entry.memory.id, topics);
        } catch (error) {
            logKbWarning("kb.inbox.topicExtraction.extract", error);
            result.set(entry.memory.id, []);
        }
    }

    return result;
}

export const ALL_CLASSIFICATIONS: KbClassification[] = [
    "fact",
    "definition",
    "how-to",
    "reference",
    "concept",
    "insight",
];

const QUERY_INTENT_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        classifications: {
            type: "array",
            items: {
                type: "string",
                enum: ["fact", "definition", "how-to", "reference", "concept", "insight"],
            },
            description: "1-3 most relevant knowledge categories for this query",
        },
        keywords: {
            type: "array",
            items: { type: "string" },
            description: "Key search terms extracted from the query",
        },
        topic: {
            type: "string",
            description: "Main topic of the query, if identifiable",
        },
    },
    required: ["classifications", "keywords"],
});

export async function classifyQueryIntent(
    text: string,
    context: DomainContext,
): Promise<QueryIntent> {
    const llm = context.llmAt("low");
    const fallback: QueryIntent = {
        classifications: [...ALL_CLASSIFICATIONS],
        keywords: text
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2),
    };

    const queryIntentPrompt = await context.loadPrompt("query-intent");

    if (llm.extractStructured) {
        try {
            const parsed = (await llm.extractStructured(
                queryIntentPrompt + text,
                QUERY_INTENT_SCHEMA,
                "Classify the query intent.",
            )) as unknown as {
                classifications?: string[];
                keywords?: string[];
                topic?: string;
            };

            const validClassifications = (parsed.classifications ?? []).filter(
                (c): c is KbClassification => VALID_CLASSIFICATIONS.has(c),
            );

            if (validClassifications.length === 0) return fallback;

            return {
                classifications: validClassifications,
                keywords:
                    Array.isArray(parsed.keywords) && parsed.keywords.length > 0
                        ? parsed.keywords
                        : fallback.keywords,
                topic: parsed.topic || undefined,
            };
        } catch {
            return fallback;
        }
    }

    if (!llm.generate) return fallback;

    try {
        const response = await llm.generate(
            queryIntentPrompt +
                text +
                '\n\nReturn JSON: {"classifications": [...], "keywords": [...], "topic": "..."}',
        );
        const match = response.match(/\{[\s\S]*\}/);
        if (!match) return fallback;

        const parsed = JSON.parse(match[0]) as {
            classifications?: string[];
            keywords?: string[];
            topic?: string;
        };

        const validClassifications = (parsed.classifications ?? []).filter(
            (c): c is KbClassification => VALID_CLASSIFICATIONS.has(c),
        );

        if (validClassifications.length === 0) return fallback;

        return {
            classifications: validClassifications,
            keywords:
                Array.isArray(parsed.keywords) && parsed.keywords.length > 0
                    ? parsed.keywords
                    : fallback.keywords,
            topic: parsed.topic || undefined,
        };
    } catch {
        return fallback;
    }
}

const BATCH_QUESTION_GENERATION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            index: { type: "number", description: "Zero-based index of the item" },
            questions: {
                type: "string",
                description: "1-2 specific questions this entry answers, joined with ' '",
            },
        },
        required: ["index", "questions"],
    },
});

/**
 * Batch generates answersQuestion text for multiple entries in a single LLM call.
 * Returns a map from memory ID to generated question text.
 */
export async function batchGenerateQuestions(
    context: DomainContext,
    entries: OwnedMemory[],
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (entries.length === 0) return result;

    const llm = context.llmAt("low");
    const questionPrompt = await context.loadPrompt("question-generation");
    const numberedItems = entries.map((e, i) => `${i}. ${e.memory.content}`).join("\n\n");

    if (llm.extractStructured) {
        try {
            const raw = (await llm.extractStructured(
                numberedItems,
                BATCH_QUESTION_GENERATION_SCHEMA,
                questionPrompt,
            )) as Array<{ index: number; questions: string }>;

            for (const item of raw) {
                if (
                    item.index >= 0 &&
                    item.index < entries.length &&
                    typeof item.questions === "string" &&
                    item.questions.trim()
                ) {
                    result.set(entries[item.index].memory.id, item.questions.trim());
                }
            }
        } catch (error) {
            logKbWarning("kb.inbox.questionGeneration.extractStructured", error);
        }
    }

    // Retry entries that the batch call skipped, individually
    if (llm.generate) {
        const missing = entries.filter((e) => !result.has(e.memory.id));
        for (const entry of missing) {
            try {
                const response = await llm.generate(
                    questionPrompt +
                        `\n\nEntry: ${entry.memory.content}\n\nReturn only the question(s), nothing else.`,
                );
                const trimmed = response.trim();
                if (trimmed) {
                    result.set(entry.memory.id, trimmed);
                }
            } catch (error) {
                logKbWarning("kb.inbox.questionGeneration.generate", error);
            }
        }
    }

    return result;
}

async function linkSingleTopic(
    context: DomainContext,
    memoryId: string,
    topicName: string,
): Promise<void> {
    const searchResult = await context.search({
        text: topicName,
        tags: [TOPIC_TAG],
        minScore: 0.8,
    });

    let topicId: string;

    if (searchResult.entries.length > 0) {
        topicId = searchResult.entries[0].id;
        const topicAttrs = searchResult.entries[0].domainAttributes[TOPIC_DOMAIN_ID] as
            | Record<string, unknown>
            | undefined;
        const currentCount = (topicAttrs?.mentionCount as number | undefined) ?? 0;

        await context.updateAttributes(topicId, {
            ...topicAttrs,
            mentionCount: currentCount + 1,
            lastMentionedAt: Date.now(),
        });
    } else {
        topicId = await context.writeMemory({
            content: topicName,
            tags: [TOPIC_TAG],
            ownership: {
                domain: TOPIC_DOMAIN_ID,
                attributes: {
                    name: topicName,
                    status: "active",
                    mentionCount: 1,
                    lastMentionedAt: Date.now(),
                    createdBy: context.domain,
                },
            },
        });
    }

    await context.graph.relate(memoryId, "about_topic", topicId, { domain: context.domain });
}
