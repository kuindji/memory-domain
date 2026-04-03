// tests-integration/kb-architecture/configurable-inbox.ts
import type { OwnedMemory, DomainContext, ScoredMemory } from "../../src/core/types.js";
import type { KbClassification } from "../../src/domains/kb/types.js";
import { KB_TAG, KB_DOMAIN_ID } from "../../src/domains/kb/types.js";
import { ensureTag, classificationToTag, linkToTopicsBatch } from "../../src/domains/kb/utils.js";
import type { PipelineStages } from "./types.js";

const VALID_CLASSIFICATIONS = new Set<string>([
    "fact",
    "definition",
    "how-to",
    "reference",
    "concept",
    "insight",
]);

const BATCH_CLASSIFICATION_PROMPT =
    "Classify each numbered item below into exactly one knowledge category:\n" +
    '- fact: a verified, discrete piece of knowledge ("HTTP 429 means Too Many Requests")\n' +
    '- definition: a term or concept definition ("Eventual consistency means...")\n' +
    '- how-to: a procedural explanation or recipe ("To reset a PostgreSQL sequence...")\n' +
    '- reference: a technical reference, specification, or standard ("RFC 7519 defines JWT...")\n' +
    '- concept: an abstract idea, principle, or mental model ("The CAP theorem states...")\n' +
    '- insight: a personal conclusion or learned lesson ("In practice, optimistic locking works better...")\n\n';

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

const BATCH_RELATIONSHIP_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            newIndex: { type: "number", description: "Zero-based index of the new entry" },
            existingId: { type: "string", description: "ID of the related existing entry" },
            relationship: {
                type: "string",
                enum: ["prerequisite", "example-of", "contrast", "elaboration"],
                description: "How the new entry relates to the existing one",
            },
        },
        required: ["newIndex", "existingId", "relationship"],
    },
});

const SUPERSESSION_PROMPT_BUDGET = 4000;

function logWarn(scope: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[kb-arch-test warning] ${scope}: ${msg}`);
}

/**
 * Creates a processInboxBatch function that only runs the enabled stages.
 */
export function createConfigurableInboxProcessor(stages: PipelineStages) {
    return async function processInboxBatch(
        entries: OwnedMemory[],
        context: DomainContext,
    ): Promise<void> {
        await context.debug.time(
            "kb.inbox.total",
            async () => {
                // Stage 1: Classification
                let classificationMap: Map<string, string>;
                if (stages.classify) {
                    classificationMap = await context.debug.time(
                        "kb.inbox.classify",
                        () => batchClassify(entries, context),
                        { entries: entries.length },
                    );
                } else {
                    classificationMap = new Map();
                    for (const entry of entries) {
                        classificationMap.set(entry.memory.id, "fact");
                    }
                }

                // Stage 2: Tag & Attribute assignment
                if (stages.tagAssign) {
                    const kbTagId = await ensureTag(context, KB_TAG);
                    await context.debug.time(
                        "kb.inbox.tagAndAttribute",
                        async () => {
                            for (const entry of entries) {
                                const classification =
                                    classificationMap.get(entry.memory.id) ?? "fact";
                                const existingSource = entry.domainAttributes.source as
                                    | string
                                    | undefined;

                                await context.updateAttributes(entry.memory.id, {
                                    classification,
                                    superseded: false,
                                    ...(existingSource ? { source: existingSource } : {}),
                                });

                                await context.tagMemory(entry.memory.id, kbTagId);

                                const classTag = classificationToTag(
                                    classification as KbClassification,
                                );
                                const classTagId = await ensureTag(context, classTag);
                                try {
                                    await context.graph.relate(classTagId, "child_of", kbTagId);
                                } catch {
                                    /* already related */
                                }
                                await context.tagMemory(entry.memory.id, classTagId);
                            }
                        },
                        { entries: entries.length },
                    );
                }

                // Stage 3: Topic linking
                if (stages.topicLink) {
                    await context.debug.time(
                        "kb.inbox.topicLinking",
                        () => linkToTopicsBatch(context, entries),
                        { entries: entries.length },
                    );
                }

                // Stage 4: Supersession detection
                if (stages.supersede) {
                    await context.debug.time(
                        "kb.inbox.supersessionDetection",
                        () => batchDetectSupersession(entries, classificationMap, context),
                        { entries: entries.length },
                    );
                }

                // Stage 5: Related knowledge linking
                if (stages.relateKnowledge) {
                    await context.debug.time(
                        "kb.inbox.relatedLinking",
                        () => batchLinkRelated(entries, classificationMap, context),
                        { entries: entries.length },
                    );
                }
            },
            { entries: entries.length },
        );
    };
}

// --- Stage implementations ---

async function batchClassify(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    const needsClassification: { entry: OwnedMemory; index: number }[] = [];
    for (let i = 0; i < entries.length; i++) {
        const existing = entries[i].domainAttributes.classification as string | undefined;
        if (existing && VALID_CLASSIFICATIONS.has(existing)) {
            result.set(entries[i].memory.id, existing);
        } else {
            needsClassification.push({ entry: entries[i], index: i });
        }
    }

    if (needsClassification.length === 0) return result;

    const classifyLlm = context.llmAt("low");
    if (!classifyLlm.generate) {
        for (const { entry } of needsClassification) {
            result.set(entry.memory.id, "fact");
        }
        return result;
    }

    const numberedItems = needsClassification
        .map((item, i) => `${i + 1}. ${item.entry.memory.content}`)
        .join("\n\n");

    const prompt =
        BATCH_CLASSIFICATION_PROMPT +
        `Items:\n${numberedItems}\n\n` +
        "Respond with ONLY one category per line, matching the item number:\n" +
        needsClassification.map((_, i) => `${i + 1}. <category>`).join("\n");

    try {
        const response = await classifyLlm.generate(prompt);
        const lines = response.trim().split("\n");

        for (let i = 0; i < needsClassification.length; i++) {
            const line = lines[i]?.trim().toLowerCase() ?? "";
            const match = line.match(/^\d+\.\s*(.+)$/);
            const normalized = match ? match[1].trim() : line;
            const classification = VALID_CLASSIFICATIONS.has(normalized) ? normalized : "fact";
            result.set(needsClassification[i].entry.memory.id, classification);
        }
    } catch (error) {
        logWarn("kb.inbox.classify", error);
        for (const { entry } of needsClassification) {
            result.set(entry.memory.id, "fact");
        }
    }

    return result;
}

async function batchDetectSupersession(
    entries: OwnedMemory[],
    classificationMap: Map<string, string>,
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    const newEntryIds = new Set(entries.map((e) => e.memory.id));
    const existingMap = new Map<string, ScoredMemory>();

    for (const entry of entries) {
        const classification = classificationMap.get(entry.memory.id) ?? "fact";
        const classTag = classificationToTag(classification as KbClassification);

        const searchResult = await context.search({
            text: entry.memory.content,
            tags: [classTag],
            minScore: 0.7,
        });

        for (const existing of searchResult.entries) {
            if (newEntryIds.has(existing.id)) continue;
            const attrs = existing.domainAttributes[KB_DOMAIN_ID] as
                | Record<string, unknown>
                | undefined;
            if (attrs && !attrs.superseded) {
                existingMap.set(existing.id, existing);
            }
        }
    }

    const existingEntries = [...existingMap.values()];
    if (existingEntries.length === 0) return;

    const batches = buildSupersessionBatches(entries, existingEntries);
    for (const batch of batches) {
        await processSupersessionBatch(batch.newEntries, batch.existingEntries, context);
    }
}

interface SupersessionBatch {
    newEntries: OwnedMemory[];
    existingEntries: ScoredMemory[];
}

function buildSupersessionBatches(
    newEntries: OwnedMemory[],
    existingEntries: ScoredMemory[],
): SupersessionBatch[] {
    const batches: SupersessionBatch[] = [];
    const totalExistingLength = existingEntries.reduce((sum, e) => sum + e.content.length, 0);

    let currentNew: OwnedMemory[] = [];
    let currentPromptLength = totalExistingLength;

    for (const entry of newEntries) {
        const entryLength = entry.memory.content.length;
        const projectedLength = currentPromptLength + entryLength;

        if (currentNew.length > 0 && projectedLength > SUPERSESSION_PROMPT_BUDGET) {
            batches.push({ newEntries: currentNew, existingEntries });
            currentNew = [];
            currentPromptLength = totalExistingLength;
        }

        currentNew.push(entry);
        currentPromptLength += entryLength;
    }

    if (currentNew.length > 0) {
        batches.push({ newEntries: currentNew, existingEntries });
    }

    return batches;
}

async function processSupersessionBatch(
    newEntries: OwnedMemory[],
    existingEntries: ScoredMemory[],
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    const newItems = newEntries.map((e, i) => `${i}. ${e.memory.content}`).join("\n");
    const existingItems = existingEntries.map((e) => `[${e.id}] ${e.content}`).join("\n");

    const prompt =
        "For each new knowledge entry, identify which existing entries it supersedes (if any). " +
        "An entry is superseded when the new entry corrects, updates, or replaces the existing one. " +
        "Only flag true supersession — not mere similarity or overlap.\n\n" +
        `New entries:\n${newItems}\n\n` +
        `Existing entries:\n${existingItems}\n\n` +
        "Return only actual supersessions. If none exist, return an empty array.";

    try {
        const pairs = (await llm.extractStructured(
            prompt,
            BATCH_SUPERSESSION_SCHEMA,
            "Identify superseded knowledge pairs.",
        )) as Array<{ newIndex: number; existingId: string }>;

        for (const pair of pairs) {
            if (pair.newIndex < 0 || pair.newIndex >= newEntries.length) continue;
            const newMemoryId = newEntries[pair.newIndex].memory.id;
            const existing = existingEntries.find((e) => e.id === pair.existingId);
            if (!existing) continue;

            await context.graph.relate(newMemoryId, "supersedes", existing.id);
            await context.updateAttributes(existing.id, {
                ...existing.domainAttributes[KB_DOMAIN_ID],
                superseded: true,
            });
        }
    } catch (error) {
        logWarn("kb.inbox.supersessionDetection", error);
    }
}

async function batchLinkRelated(
    entries: OwnedMemory[],
    classificationMap: Map<string, string>,
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    const newEntryIds = new Set(entries.map((e) => e.memory.id));
    const relatedMap = new Map<string, ScoredMemory>();

    for (const entry of entries) {
        const searchResult = await context.search({
            text: entry.memory.content,
            tags: [KB_TAG],
            minScore: 0.75,
        });

        for (const candidate of searchResult.entries) {
            if (newEntryIds.has(candidate.id)) continue;
            const attrs = candidate.domainAttributes[KB_DOMAIN_ID] as
                | Record<string, unknown>
                | undefined;
            if (attrs?.superseded) continue;
            relatedMap.set(candidate.id, candidate);
        }
    }

    const relatedEntries = [...relatedMap.values()];
    if (relatedEntries.length === 0) return;

    const newItems = entries
        .map(
            (e, i) => `${i}. [${classificationMap.get(e.memory.id) ?? "fact"}] ${e.memory.content}`,
        )
        .join("\n");
    const existingItems = relatedEntries.map((e) => `[${e.id}] ${e.content}`).join("\n");

    const prompt =
        "For each new knowledge entry, identify which existing entries are directly related (but NOT superseded). " +
        "Describe the relationship type: prerequisite (must understand this first), example-of (illustrates a concept), " +
        "contrast (presents an opposing or alternative view), elaboration (adds detail to existing knowledge).\n\n" +
        `New entries:\n${newItems}\n\n` +
        `Existing entries:\n${existingItems}\n\n` +
        "Return only meaningful relationships. If none exist, return an empty array.";

    try {
        const relationships = (await llm.extractStructured(
            prompt,
            BATCH_RELATIONSHIP_SCHEMA,
            "Identify related knowledge pairs.",
        )) as Array<{ newIndex: number; existingId: string; relationship: string }>;

        for (const rel of relationships) {
            if (rel.newIndex < 0 || rel.newIndex >= entries.length) continue;
            const newMemoryId = entries[rel.newIndex].memory.id;
            const existing = relatedEntries.find((e) => e.id === rel.existingId);
            if (!existing) continue;

            try {
                await context.graph.relate(newMemoryId, "related_knowledge", existing.id, {
                    relationship: rel.relationship,
                });
            } catch {
                /* best-effort */
            }
        }
    } catch (error) {
        logWarn("kb.inbox.relatedLinking", error);
    }
}
