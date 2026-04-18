import type { DomainContext } from "../../core/types.js";
import { formatTagId } from "../../core/tag-utils.js";
import type { MemoryClassification } from "./types.js";
import {
    CLASSIFICATION_TAGS,
    CODE_REPO_DOMAIN_ID,
    DEFAULT_IMPORTANCE,
    MAX_ATOMIC_FACTS,
} from "./types.js";

const VALID_CLASSIFICATIONS = new Set<string>([
    "decision",
    "rationale",
    "clarification",
    "direction",
    "observation",
    "question",
]);

function logCodeRepoWarning(scope: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[memory-domain warning] ${scope}: ${errorMessage}`);
}

/**
 * Checks whether a code-repo entry is valid for retrieval.
 * Returns false if superseded, decomposed, or temporally expired.
 */
export function isEntryValid(attrs: Record<string, unknown> | undefined, now: number): boolean {
    if (!attrs) return true;
    if (attrs.superseded) return false;
    if (attrs.decomposed) return false;
    if (typeof attrs.validUntil === "number" && attrs.validUntil < now) return false;
    return true;
}

/**
 * Extracts code-repo domain attributes from a scored memory's domainAttributes map.
 */
export function getCodeRepoAttrs(
    domainAttributes: Record<string, Record<string, unknown>>,
    domainId: string = CODE_REPO_DOMAIN_ID,
): Record<string, unknown> | undefined {
    return domainAttributes[domainId] as Record<string, unknown> | undefined;
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
 * Computes effective importance with time-based decay.
 */
export function computeImportance(
    attrs: Record<string, unknown> | undefined,
    decayFactor: number,
): number {
    const classification = (attrs?.classification as MemoryClassification) ?? "observation";
    const baseImportance =
        (attrs?.importance as number) ?? DEFAULT_IMPORTANCE[classification] ?? 0.5;
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
                enum: [
                    "decision",
                    "rationale",
                    "clarification",
                    "direction",
                    "observation",
                    "question",
                ],
                description: "Best classification for this atomic claim",
            },
        },
        required: ["claim"],
    },
});

/**
 * Decomposes a long entry into atomic facts using LLM extraction.
 * Returns null if decomposition is not worthwhile (<=1 fact or extraction fails).
 */
export async function decomposeToAtomicFacts(
    content: string,
    context: DomainContext,
): Promise<Array<{ claim: string; classification?: MemoryClassification }> | null> {
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
                ? (r.classification as MemoryClassification)
                : undefined,
        }));
    } catch {
        return null;
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
    entries: import("../../core/types.js").OwnedMemory[],
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
            logCodeRepoWarning("code-repo.inbox.questionGeneration.extractStructured", error);
        }
    }

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
                logCodeRepoWarning("code-repo.inbox.questionGeneration.generate", error);
            }
        }
    }

    return result;
}

/**
 * Ensures a tag node exists in the graph with the given label.
 */
export async function ensureTag(context: DomainContext, label: string): Promise<string> {
    const tagId = formatTagId(label);
    try {
        await context.graph.createNodeWithId(tagId, { label, created_at: Date.now() });
    } catch {
        /* already exists */
    }
    return tagId;
}

/**
 * Searches for an existing entity node by type and name, creates if not found.
 * Returns the node ID.
 */
export async function findOrCreateEntity(
    context: DomainContext,
    type: string,
    name: string,
    fields?: Record<string, unknown>,
): Promise<string> {
    // Search for existing entity by name
    const results = await context.graph.query<Array<{ id: string }>>(
        `SELECT id FROM type::table($type) WHERE name = $name LIMIT 1`,
        { type, name },
    );

    if (Array.isArray(results) && results.length > 0) {
        return results[0].id;
    }

    // Create new entity node
    return context.graph.createNode(type, { name, ...fields });
}

/**
 * Maps a classification string to its corresponding tag path.
 */
export function classificationToTag(classification: MemoryClassification): string {
    return CLASSIFICATION_TAGS[classification];
}
