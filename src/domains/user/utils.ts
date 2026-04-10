import type { DomainContext, OwnedMemory } from "../../core/types.js";
import { USER_DOMAIN_ID, DEFAULT_USER_IMPORTANCE } from "./types.js";
import type { UserFactClassification } from "./types.js";

function logUserWarning(scope: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[memory-domain warning] ${scope}: ${errorMessage}`);
}

/**
 * Checks whether a user entry is valid for retrieval.
 * Returns false if superseded or temporally expired.
 */
export function isEntryValid(attrs: Record<string, unknown> | undefined, now: number): boolean {
    if (!attrs) return true;
    if (attrs.superseded) return false;
    if (typeof attrs.validUntil === "number" && attrs.validUntil < now) return false;
    return true;
}

/**
 * Extracts user domain attributes from a scored memory's domainAttributes map.
 */
export function getUserAttrs(
    domainAttributes: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
    return domainAttributes[USER_DOMAIN_ID] as Record<string, unknown> | undefined;
}

/**
 * Records an access event for a memory retrieved in a user-domain query.
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
 * Computes effective importance for a user fact with time-based decay.
 */
export function computeImportance(
    attrs: Record<string, unknown> | undefined,
    decayFactor: number,
): number {
    const classification = (attrs?.classification as UserFactClassification) ?? "other";
    const baseImportance =
        (attrs?.importance as number) ?? DEFAULT_USER_IMPORTANCE[classification] ?? 0.5;
    const lastAccessed = attrs?.lastAccessedAt as number | undefined;
    if (!lastAccessed) return baseImportance;

    const daysSinceAccess = (Date.now() - lastAccessed) / (1000 * 60 * 60 * 24);
    return baseImportance * Math.pow(decayFactor, daysSinceAccess / 30);
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
 * Batch generates answersQuestion text for multiple user facts in a single LLM call.
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
            logUserWarning("user.inbox.questionGeneration.extractStructured", error);
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
                logUserWarning("user.inbox.questionGeneration.generate", error);
            }
        }
    }

    return result;
}
