import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedMemory, DomainContext, ScoredMemory } from "../../core/types.js";
import { loadPrompt } from "../../core/prompt-loader.js";
import {
    CODE_REPO_TAG,
    CODE_REPO_DOMAIN_ID,
    CODE_REPO_DECISION_TAG,
    AUDIENCE_TAGS,
} from "./types.js";
import type { MemoryClassification, Audience } from "./types.js";
import { ensureTag, findOrCreateEntity, linkToTopicsBatch, classificationToTag } from "./utils.js";

const BASE_DIR = dirname(fileURLToPath(import.meta.url));

function logCodeRepoInboxWarning(scope: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[memory-domain warning] ${scope}: ${errorMessage}`);
}

const VALID_CLASSIFICATIONS = new Set<string>([
    "decision",
    "rationale",
    "clarification",
    "direction",
    "observation",
    "question",
]);

const VALID_AUDIENCES = new Set<string>(["technical", "business"]);

const BATCH_ENTITY_EXTRACTION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            index: { type: "number", description: "Zero-based index of the item" },
            entities: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Entity name" },
                        type: {
                            type: "string",
                            enum: ["module", "data_entity", "concept", "pattern"],
                            description: "Entity type",
                        },
                        path: { type: "string", description: "File system path (for modules)" },
                        kind: {
                            type: "string",
                            enum: ["package", "service", "lambda", "subsystem", "library"],
                            description: "Module kind (only for module type)",
                        },
                    },
                    required: ["name", "type"],
                },
            },
        },
        required: ["index", "entities"],
    },
});

const BATCH_CONTRADICTION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            newIndex: { type: "number", description: "Zero-based index of the new decision" },
            existingId: { type: "string", description: "ID of the contradicted existing decision" },
        },
        required: ["newIndex", "existingId"],
    },
});

const CONTRADICTION_PROMPT_BUDGET = 4000;

interface EntityResult {
    name: string;
    type: string;
    path?: string;
    kind?: string;
}

export async function processInboxBatch(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<void> {
    await context.debug.time(
        "code-repo.inbox.total",
        async () => {
            const audienceMap = new Map<string, string[]>();
            for (const entry of entries) {
                let audience = entry.domainAttributes.audience as string[] | undefined;
                if (!audience || !Array.isArray(audience)) {
                    audience = ["technical"];
                } else {
                    audience = audience.filter((a) => VALID_AUDIENCES.has(a));
                    if (audience.length === 0) audience = ["technical"];
                }
                audienceMap.set(entry.memory.id, audience);
            }

            const classificationMap = await context.debug.time(
                "code-repo.inbox.classify",
                () => batchClassify(entries, context),
                { entries: entries.length },
            );

            const codeRepoTagId = await ensureTag(context, CODE_REPO_TAG);

            await context.debug.time(
                "code-repo.inbox.tagAndAttribute",
                async () => {
                    for (const entry of entries) {
                        const classification =
                            classificationMap.get(entry.memory.id) ?? "observation";
                        const audience = audienceMap.get(entry.memory.id) ?? ["technical"];

                        await context.updateAttributes(entry.memory.id, {
                            classification,
                            audience,
                            superseded: false,
                        });

                        await context.tagMemory(entry.memory.id, codeRepoTagId);

                        const classTag = classificationToTag(
                            classification as MemoryClassification,
                        );
                        const classTagId = await ensureTag(context, classTag);
                        try {
                            await context.graph.relate(classTagId, "child_of", codeRepoTagId);
                        } catch {
                            /* already related */
                        }
                        await context.tagMemory(entry.memory.id, classTagId);

                        for (const aud of audience) {
                            const audTag = AUDIENCE_TAGS[aud as Audience];
                            if (audTag) {
                                const audTagId = await ensureTag(context, audTag);
                                try {
                                    await context.graph.relate(audTagId, "child_of", codeRepoTagId);
                                } catch {
                                    /* already related */
                                }
                                await context.tagMemory(entry.memory.id, audTagId);
                            }
                        }
                    }
                },
                { entries: entries.length },
            );

            const entitiesMap = await context.debug.time(
                "code-repo.inbox.entityExtraction",
                () => batchExtractEntities(entries, context),
                { entries: entries.length },
            );

            await context.debug.time(
                "code-repo.inbox.entityLinking",
                async () => {
                    for (const entry of entries) {
                        const entities = entitiesMap.get(entry.memory.id) ?? [];
                        for (const entity of entities) {
                            if (!entity.name || !entity.type) continue;
                            const fields: Record<string, unknown> = {};
                            if (entity.path) fields.path = entity.path;
                            if (entity.kind) fields.kind = entity.kind;

                            try {
                                const entityId = await findOrCreateEntity(
                                    context,
                                    entity.type,
                                    entity.name,
                                    fields,
                                );
                                await context.graph.relate(
                                    entry.memory.id,
                                    "about_entity",
                                    entityId,
                                    { relevance: 1.0 },
                                );
                            } catch {
                                // Entity linking is best-effort
                            }
                        }
                    }
                },
                { entries: entries.length },
            );

            await context.debug.time(
                "code-repo.inbox.topicLinking",
                () => linkToTopicsBatch(context, entries),
                { entries: entries.length },
            );

            const decisions = entries.filter(
                (e) => classificationMap.get(e.memory.id) === "decision",
            );
            if (decisions.length > 0) {
                await context.debug.time(
                    "code-repo.inbox.contradictionDetection",
                    () => batchDetectContradictions(decisions, context),
                    { decisions: decisions.length },
                );
            }
        },
        { entries: entries.length },
    );
}

async function batchClassify(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    // Separate entries that already have valid classifications
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
        // No generate capability — default all to observation
        for (const { entry } of needsClassification) {
            result.set(entry.memory.id, "observation");
        }
        return result;
    }

    const classificationPrompt = await loadPrompt(BASE_DIR, "classification");
    const numberedItems = needsClassification
        .map((item, i) => `${i + 1}. ${item.entry.memory.content}`)
        .join("\n\n");

    const prompt =
        classificationPrompt +
        `\n\nItems:\n${numberedItems}\n\n` +
        "Respond with ONLY one category per line, matching the item number:\n" +
        needsClassification.map((_, i) => `${i + 1}. <category>`).join("\n");

    try {
        const response = await classifyLlm.generate(prompt);
        const lines = response.trim().split("\n");

        for (let i = 0; i < needsClassification.length; i++) {
            const line = lines[i]?.trim().toLowerCase() ?? "";
            // Parse "1. decision" or just "decision"
            const match = line.match(/^\d+\.\s*(.+)$/);
            const normalized = match ? match[1].trim() : line;
            const classification = VALID_CLASSIFICATIONS.has(normalized)
                ? normalized
                : "observation";
            result.set(needsClassification[i].entry.memory.id, classification);
        }
    } catch (error) {
        logCodeRepoInboxWarning("code-repo.inbox.classify", error);
        // Fallback: default to observation
        for (const { entry } of needsClassification) {
            result.set(entry.memory.id, "observation");
        }
    }

    return result;
}

async function batchExtractEntities(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<Map<string, EntityResult[]>> {
    const result = new Map<string, EntityResult[]>();
    const entityLlm = context.llmAt("medium");

    if (!entityLlm.extractStructured) return result;

    const entityPrompt = await loadPrompt(BASE_DIR, "entity-extraction");
    const numberedItems = entries.map((e, i) => `${i}. ${e.memory.content}`).join("\n\n");

    try {
        const raw = (await entityLlm.extractStructured(
            numberedItems,
            BATCH_ENTITY_EXTRACTION_SCHEMA,
            entityPrompt,
        )) as Array<{ index: number; entities: EntityResult[] }>;

        for (const item of raw) {
            if (item.index >= 0 && item.index < entries.length && Array.isArray(item.entities)) {
                result.set(entries[item.index].memory.id, item.entities);
            }
        }
    } catch (error) {
        logCodeRepoInboxWarning("code-repo.inbox.entityExtraction", error);
        // Entity extraction is best-effort
    }

    return result;
}

async function batchDetectContradictions(
    decisions: OwnedMemory[],
    context: DomainContext,
): Promise<void> {
    const contradictionLlm = context.llmAt("low");
    if (!contradictionLlm.generate || !context.llmAt("low").extractStructured) return;

    // Collect all existing non-superseded decisions via a combined search
    const existingDecisionsMap = new Map<string, ScoredMemory>();
    const newDecisionIds = new Set(decisions.map((d) => d.memory.id));

    for (const decision of decisions) {
        const searchResult = await context.search({
            text: decision.memory.content,
            tags: [CODE_REPO_DECISION_TAG],
            minScore: 0.7,
        });

        for (const existing of searchResult.entries) {
            if (newDecisionIds.has(existing.id)) continue;
            const attrs = existing.domainAttributes[CODE_REPO_DOMAIN_ID] as
                | Record<string, unknown>
                | undefined;
            if (attrs && !attrs.superseded) {
                existingDecisionsMap.set(existing.id, existing);
            }
        }
    }

    const existingDecisions = [...existingDecisionsMap.values()];
    if (existingDecisions.length === 0) return;

    // Build comparison batches based on prompt length
    const batches = buildContradictionBatches(decisions, existingDecisions);

    for (const batch of batches) {
        await processContradictionBatch(batch.newDecisions, batch.existingDecisions, context);
    }
}

interface ContradictionBatch {
    newDecisions: OwnedMemory[];
    existingDecisions: ScoredMemory[];
}

function buildContradictionBatches(
    newDecisions: OwnedMemory[],
    existingDecisions: ScoredMemory[],
): ContradictionBatch[] {
    const batches: ContradictionBatch[] = [];

    // Estimate prompt length per item
    const existingLengths = existingDecisions.map((d) => d.content.length);
    const totalExistingLength = existingLengths.reduce((sum, l) => sum + l, 0);

    let currentNew: OwnedMemory[] = [];
    let currentPromptLength = totalExistingLength; // existing decisions are always included

    for (const decision of newDecisions) {
        const decisionLength = decision.memory.content.length;
        const projectedLength = currentPromptLength + decisionLength;

        if (currentNew.length > 0 && projectedLength > CONTRADICTION_PROMPT_BUDGET) {
            // Current batch is full, start a new one
            batches.push({ newDecisions: currentNew, existingDecisions });
            currentNew = [];
            currentPromptLength = totalExistingLength;
        }

        currentNew.push(decision);
        currentPromptLength += decisionLength;
    }

    if (currentNew.length > 0) {
        batches.push({ newDecisions: currentNew, existingDecisions });
    }

    return batches;
}

async function processContradictionBatch(
    newDecisions: OwnedMemory[],
    existingDecisions: ScoredMemory[],
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    const contradictionPrompt = await loadPrompt(BASE_DIR, "contradiction");

    const newItems = newDecisions.map((d, i) => `${i}. ${d.memory.content}`).join("\n");

    const existingItems = existingDecisions.map((d) => `[${d.id}] ${d.content}`).join("\n");

    const prompt =
        contradictionPrompt +
        `\n\nNew decisions:\n${newItems}\n\n` +
        `Existing decisions:\n${existingItems}\n\n` +
        "Return only actual contradictions. If none exist, return an empty array.";

    try {
        const pairs = (await llm.extractStructured(
            prompt,
            BATCH_CONTRADICTION_SCHEMA,
            "Identify contradicting decision pairs.",
        )) as Array<{ newIndex: number; existingId: string }>;

        for (const pair of pairs) {
            if (pair.newIndex < 0 || pair.newIndex >= newDecisions.length) continue;
            const newMemoryId = newDecisions[pair.newIndex].memory.id;
            const existing = existingDecisions.find((d) => d.id === pair.existingId);
            if (!existing) continue;

            await context.graph.relate(newMemoryId, "supersedes", existing.id);
            await context.updateAttributes(existing.id, {
                ...existing.domainAttributes[CODE_REPO_DOMAIN_ID],
                superseded: true,
            });
        }
    } catch (error) {
        logCodeRepoInboxWarning("code-repo.inbox.contradictionDetection", error);
        // Contradiction detection is best-effort
    }
}
