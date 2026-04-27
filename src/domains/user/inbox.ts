import type { OwnedMemory, DomainContext } from "../../core/types.js";
import { USER_TAG, DEFAULT_USER_IMPORTANCE } from "./types.js";
import type { UserFactClassification } from "./types.js";
import { batchGenerateQuestions } from "./utils.js";

function logUserInboxWarning(scope: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[memory-domain warning] ${scope}: ${errorMessage}`);
}

const VALID_CLASSIFICATIONS = new Set<string>([
    "identity",
    "preference",
    "expertise",
    "goal",
    "relationship",
    "habit",
    "other",
]);

const BATCH_CLASSIFICATION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            index: { type: "number", description: "Zero-based index of the item" },
            classification: {
                type: "string",
                enum: [
                    "identity",
                    "preference",
                    "expertise",
                    "goal",
                    "relationship",
                    "habit",
                    "other",
                ],
            },
        },
        required: ["index", "classification"],
    },
});

const BATCH_SUPERSESSION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            newIndex: { type: "number", description: "Zero-based index of the new entry" },
            existingId: { type: "string", description: "ID of the superseded existing entry" },
        },
        required: ["newIndex", "existingId"],
    },
});

const SUPERSESSION_PROMPT_BUDGET = 4000;

interface ExistingUserFact {
    id: string;
    content: string;
    attributes: Record<string, unknown>;
}

export async function processInboxBatch(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<void> {
    await context.debug.time(
        "user.inbox.total",
        async () => {
            // Stage 1: Classify (skip entries that arrive with a valid classification)
            const classificationMap = await context.debug.time(
                "user.inbox.classify",
                () => batchClassify(entries, context),
                { entries: entries.length },
            );

            // Stage 1.5: Question generation
            const questionMap = await context.debug.time(
                "user.inbox.questionGeneration",
                () => batchGenerateQuestions(context, entries),
                { entries: entries.length },
            );

            // Stage 2: Tag + attribute assignment + ensure about_user edge
            await context.debug.time(
                "user.inbox.tagAndAttribute",
                async () => {
                    for (const entry of entries) {
                        const classification = (classificationMap.get(entry.memory.id) ??
                            "other") as UserFactClassification;
                        const answersQuestion = questionMap.get(entry.memory.id);
                        const userId = entry.domainAttributes.userId as string | undefined;

                        await context.updateAttributes(entry.memory.id, {
                            ...entry.domainAttributes,
                            classification,
                            superseded: false,
                            validFrom: Date.now(),
                            confidence: 1.0,
                            importance: DEFAULT_USER_IMPORTANCE[classification],
                            ...(userId ? { userId } : {}),
                            ...(answersQuestion ? { answersQuestion } : {}),
                        });

                        await context.tagMemory(entry.memory.id, await ensureUserTag(context));

                        // Denormalize classification and answers_question onto memory record
                        try {
                            await context.graph.query(
                                "UPDATE memory SET classification = $1, answers_question = $2 WHERE id = $3",
                                [classification, answersQuestion ?? null, entry.memory.id],
                            );
                        } catch {
                            /* best-effort denormalization */
                        }

                        // Ensure about_user edge if userId is present and not already linked
                        if (userId) {
                            await ensureAboutUserEdge(context, entry.memory.id, userId);
                        }
                    }
                },
                { entries: entries.length },
            );

            // Stage 3: Per-user supersession detection
            await context.debug.time(
                "user.inbox.supersessionDetection",
                () => detectSupersessionPerUser(entries, classificationMap, context),
                { entries: entries.length },
            );
        },
        { entries: entries.length },
    );
}

async function ensureUserTag(context: DomainContext): Promise<string> {
    const tagId = `tag:${USER_TAG}`;
    try {
        await context.graph.createNodeWithId(tagId, {
            label: USER_TAG,
            created_at: Date.now(),
        });
    } catch {
        /* already exists */
    }
    return tagId;
}

async function ensureAboutUserEdge(
    context: DomainContext,
    memoryId: string,
    userId: string,
): Promise<void> {
    const userNodeId = `user:${userId}`;

    // Create the user node if it does not exist
    try {
        await context.graph.createNodeWithId(userNodeId, { userId });
    } catch {
        /* already exists */
    }

    try {
        // Check for existing about_user edge between this memory and user
        const existing = await context.graph.query<{ id: string }>(
            "SELECT id FROM about_user WHERE in_id = $1 AND out_id = $2 LIMIT 1",
            [memoryId, userNodeId],
        );
        if (existing && existing.length > 0) return;

        await context.graph.relate(memoryId, "about_user", userNodeId, {
            domain: context.domain,
        });
    } catch (error) {
        logUserInboxWarning("user.inbox.ensureAboutUserEdge", error);
    }
}

async function batchClassify(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    const needsClassification: OwnedMemory[] = [];
    for (const entry of entries) {
        const existing = entry.domainAttributes.classification as string | undefined;
        if (existing && VALID_CLASSIFICATIONS.has(existing)) {
            result.set(entry.memory.id, existing);
        } else {
            needsClassification.push(entry);
        }
    }

    if (needsClassification.length === 0) return result;

    const llm = context.llmAt("low");
    if (!llm.extractStructured && !llm.generate) {
        for (const entry of needsClassification) {
            result.set(entry.memory.id, "other");
        }
        return result;
    }

    const classificationPrompt = await context.loadPrompt("classification");
    const numberedItems = needsClassification
        .map((e, i) => `${i}. ${e.memory.content}`)
        .join("\n\n");

    if (llm.extractStructured) {
        try {
            const raw = (await llm.extractStructured(
                `Items:\n${numberedItems}`,
                BATCH_CLASSIFICATION_SCHEMA,
                classificationPrompt,
            )) as Array<{ index: number; classification: string }>;

            for (const item of raw) {
                if (item.index >= 0 && item.index < needsClassification.length) {
                    const cls = VALID_CLASSIFICATIONS.has(item.classification)
                        ? item.classification
                        : "other";
                    result.set(needsClassification[item.index].memory.id, cls);
                }
            }
        } catch (error) {
            logUserInboxWarning("user.inbox.classify.extractStructured", error);
        }
    }

    for (const entry of needsClassification) {
        if (!result.has(entry.memory.id)) {
            result.set(entry.memory.id, "other");
        }
    }

    return result;
}

/**
 * Per-user supersession. Groups incoming entries by userId, fetches existing
 * facts linked to the same user via about_user, and LLM-compares for supersession
 * within that user's own fact set.
 */
async function detectSupersessionPerUser(
    entries: OwnedMemory[],
    classificationMap: Map<string, string>,
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    // Group new entries by userId
    const byUser = new Map<string, OwnedMemory[]>();
    for (const entry of entries) {
        const userId = entry.domainAttributes.userId as string | undefined;
        if (!userId) continue;
        const group = byUser.get(userId) ?? [];
        group.push(entry);
        byUser.set(userId, group);
    }

    for (const [userId, userEntries] of byUser) {
        const existing = await fetchExistingUserFacts(context, userId, userEntries);
        if (existing.length === 0) continue;

        const supersessionPrompt = await context.loadPrompt("supersession");

        const newItems = userEntries
            .map(
                (e, i) =>
                    `${i}. [${classificationMap.get(e.memory.id) ?? "other"}] ${e.memory.content}`,
            )
            .join("\n");
        const existingItems = existing
            .map((e) => {
                const cls =
                    typeof e.attributes.classification === "string"
                        ? e.attributes.classification
                        : "other";
                return `[${e.id}] [${cls}] ${e.content}`;
            })
            .join("\n");

        // Simple single-batch processing — user fact sets are typically small
        const totalLen = newItems.length + existingItems.length;
        if (totalLen > SUPERSESSION_PROMPT_BUDGET * 2) {
            logUserInboxWarning(
                "user.inbox.supersessionDetection",
                new Error(`Skipping oversize supersession batch for user ${userId}`),
            );
            continue;
        }

        const prompt =
            supersessionPrompt +
            `\n\nNew user facts:\n${newItems}\n\n` +
            `Existing user facts:\n${existingItems}\n\n` +
            "Return only actual supersessions. If none exist, return an empty array.";

        try {
            const pairs = (await llm.extractStructured(
                prompt,
                BATCH_SUPERSESSION_SCHEMA,
                "Identify superseded user-fact pairs.",
            )) as Array<{ newIndex: number; existingId: string }>;

            for (const pair of pairs) {
                if (pair.newIndex < 0 || pair.newIndex >= userEntries.length) continue;
                const newMemoryId = userEntries[pair.newIndex].memory.id;
                const target = existing.find((e) => e.id === pair.existingId);
                if (!target) continue;

                await context.graph.relate(newMemoryId, "supersedes", target.id);
                await context.updateAttributes(target.id, {
                    ...target.attributes,
                    superseded: true,
                    validUntil: Date.now(),
                });
            }
        } catch (error) {
            logUserInboxWarning("user.inbox.supersessionDetection", error);
        }
    }
}

/**
 * Fetches all existing non-superseded user facts linked to a given userId
 * via about_user edges, excluding the new-entry set.
 */
async function fetchExistingUserFacts(
    context: DomainContext,
    userId: string,
    newEntries: OwnedMemory[],
): Promise<ExistingUserFact[]> {
    const userNodeId = `user:${userId}`;
    const newIds = new Set(newEntries.map((e) => e.memory.id));

    try {
        // Fetch memories linked via about_user to this user, joined with the
        // memory row and (optional) owned_by attributes for the user domain.
        const rows = await context.graph.query<{
            in_id: string;
            content: string | null;
            attributes: Record<string, unknown> | null;
        }>(
            `SELECT au.in_id, m.content, ob.attributes
             FROM about_user au
             JOIN memory m ON m.id = au.in_id
             LEFT JOIN owned_by ob ON ob.in_id = au.in_id AND ob.out_id = $2
             WHERE au.out_id = $1`,
            [userNodeId, `domain:${context.domain}`],
        );

        if (!rows) return [];

        const result: ExistingUserFact[] = [];
        for (const row of rows) {
            const id = row.in_id;
            if (newIds.has(id)) continue;
            const attrs = row.attributes ?? {};
            if (attrs.superseded) continue;
            if (!row.content) continue;
            result.push({ id, content: row.content, attributes: attrs });
        }
        return result;
    } catch (error) {
        logUserInboxWarning("user.inbox.fetchExistingUserFacts", error);
        return [];
    }
}
