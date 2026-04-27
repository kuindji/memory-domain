import type { OwnedMemory, DomainContext, ScoredMemory } from "../../core/types.js";
import {
    CODE_REPO_TAG,
    CODE_REPO_DECISION_TAG,
    AUDIENCE_TAGS,
    DEFAULT_IMPORTANCE,
    DECOMPOSITION_TOKEN_THRESHOLD,
} from "./types.js";
import type { MemoryClassification, Audience } from "./types.js";
import {
    ensureTag,
    findOrCreateEntity,
    classificationToTag,
    decomposeToAtomicFacts,
    batchGenerateQuestions,
} from "./utils.js";
import { countTokens } from "../../core/scoring.js";

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

interface EntityResult {
    name: string;
    type: string;
    path?: string;
    kind?: string;
}

interface DecomposeResult {
    processable: OwnedMemory[];
    decomposedParents: OwnedMemory[];
}

export async function processInboxBatch(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<void> {
    await context.debug.time(
        "code-repo.inbox.total",
        async () => {
            // Stage 0: Atomic fact decomposition (long entries only)
            const { processable: processableEntries, decomposedParents } = await context.debug.time(
                "code-repo.inbox.decompose",
                () => decomposeEntries(entries, context),
                { entries: entries.length },
            );

            // Audience map (carry through from initial attributes)
            const audienceMap = new Map<string, string[]>();
            for (const entry of processableEntries) {
                let audience = entry.domainAttributes.audience as string[] | undefined;
                if (!audience || !Array.isArray(audience)) {
                    audience = ["technical"];
                } else {
                    audience = audience.filter((a) => VALID_AUDIENCES.has(a));
                    if (audience.length === 0) audience = ["technical"];
                }
                audienceMap.set(entry.memory.id, audience);
            }

            // Stage 1: Classification
            const classificationMap = await context.debug.time(
                "code-repo.inbox.classify",
                () => batchClassify(processableEntries, context),
                { entries: processableEntries.length },
            );

            // Classify decomposed parents separately so they get a classification for search/display
            if (decomposedParents.length > 0) {
                const parentClassificationMap = await context.debug.time(
                    "code-repo.inbox.classifyParents",
                    () => batchClassify(decomposedParents, context),
                    { entries: decomposedParents.length },
                );
                for (const parent of decomposedParents) {
                    const classification =
                        parentClassificationMap.get(parent.memory.id) ?? "observation";
                    const parentAudience = (parent.domainAttributes.audience as
                        | string[]
                        | undefined) ?? ["technical"];
                    await context.updateAttributes(parent.memory.id, {
                        ...parent.domainAttributes,
                        classification,
                        audience: parentAudience,
                        decomposed: true,
                    });
                }
            }

            // Stage 1.5: Question generation (what questions does this entry answer?)
            const questionMap = await context.debug.time(
                "code-repo.inbox.questionGeneration",
                () => batchGenerateQuestions(context, processableEntries),
                { entries: processableEntries.length },
            );

            const codeRepoTagId = await ensureTag(context, CODE_REPO_TAG);

            // Stage 2: Tag + attribute assignment (with importance/validFrom/answersQuestion)
            await context.debug.time(
                "code-repo.inbox.tagAndAttribute",
                async () => {
                    for (const entry of processableEntries) {
                        const classification = (classificationMap.get(entry.memory.id) ??
                            "observation") as MemoryClassification;
                        const audience = audienceMap.get(entry.memory.id) ?? ["technical"];
                        const existingSource = entry.domainAttributes.source as string | undefined;
                        const existingParentId = entry.domainAttributes.parentMemoryId as
                            | string
                            | undefined;
                        const answersQuestion = questionMap.get(entry.memory.id);

                        await context.updateAttributes(entry.memory.id, {
                            classification,
                            audience,
                            superseded: false,
                            validFrom: Date.now(),
                            confidence: 1.0,
                            importance: DEFAULT_IMPORTANCE[classification],
                            ...(existingSource ? { source: existingSource } : {}),
                            ...(existingParentId ? { parentMemoryId: existingParentId } : {}),
                            ...(answersQuestion ? { answersQuestion } : {}),
                        });

                        await context.tagMemory(entry.memory.id, codeRepoTagId);

                        const classTag = classificationToTag(classification);
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

                        // Denormalize classification and answers_question onto memory record
                        try {
                            await context.graph.query(
                                "UPDATE memory SET classification = $1, answers_question = $2 WHERE id = $3",
                                [classification, answersQuestion ?? null, entry.memory.id],
                            );
                        } catch {
                            /* best-effort denormalization */
                        }
                    }
                },
                { entries: processableEntries.length },
            );

            // Stage 3: Entity extraction and linking
            const entitiesMap = await context.debug.time(
                "code-repo.inbox.entityExtraction",
                () => batchExtractEntities(processableEntries, context),
                { entries: processableEntries.length },
            );

            await context.debug.time(
                "code-repo.inbox.entityLinking",
                async () => {
                    for (const entry of processableEntries) {
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
                { entries: processableEntries.length },
            );

            // Stage 4: Supersession detection (decisions only — preserves existing scope)
            const decisions = processableEntries.filter(
                (e) => classificationMap.get(e.memory.id) === "decision",
            );
            if (decisions.length > 0) {
                await context.debug.time(
                    "code-repo.inbox.supersessionDetection",
                    () => batchDetectSupersession(decisions, context),
                    { decisions: decisions.length },
                );
            }

            // Stage 6: Related-knowledge linking
            await context.debug.time(
                "code-repo.inbox.relatedLinking",
                () => batchLinkRelated(processableEntries, classificationMap, context),
                { entries: processableEntries.length },
            );
        },
        { entries: entries.length },
    );
}

async function decomposeEntries(
    entries: OwnedMemory[],
    context: DomainContext,
): Promise<DecomposeResult> {
    const processable: OwnedMemory[] = [];
    const decomposedParents: OwnedMemory[] = [];

    for (const entry of entries) {
        const tokens = countTokens(entry.memory.content);
        if (tokens <= DECOMPOSITION_TOKEN_THRESHOLD) {
            processable.push(entry);
            continue;
        }

        const atomicFacts = await decomposeToAtomicFacts(entry.memory.content, context);
        if (!atomicFacts || atomicFacts.length <= 1) {
            processable.push(entry);
            continue;
        }

        // Mark parent as decomposed
        await context.updateAttributes(entry.memory.id, {
            ...entry.domainAttributes,
            decomposed: true,
        });

        decomposedParents.push(entry);

        // Create child memories
        for (const fact of atomicFacts) {
            const childId = await context.writeMemory({
                content: fact.claim,
                tags: [CODE_REPO_TAG],
                ownership: {
                    domain: context.domain,
                    attributes: {
                        source: "decomposed",
                        parentMemoryId: entry.memory.id,
                        audience: entry.domainAttributes.audience ?? ["technical"],
                        ...(fact.classification ? { classification: fact.classification } : {}),
                    },
                },
            });

            // Link child to parent via core refines edge
            await context.graph.relate(childId, "refines", entry.memory.id);

            const childMemory = await context.getMemory(childId);
            if (childMemory) {
                processable.push({
                    memory: childMemory,
                    domainAttributes: {
                        source: "decomposed",
                        parentMemoryId: entry.memory.id,
                        audience: entry.domainAttributes.audience ?? ["technical"],
                        ...(fact.classification ? { classification: fact.classification } : {}),
                    },
                    tags: [CODE_REPO_TAG],
                });
            }
        }
    }

    return { processable, decomposedParents };
}

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
            result.set(entry.memory.id, "observation");
        }
        return result;
    }

    const classificationPrompt = await context.loadPrompt("classification");
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
            const match = line.match(/^\d+\.\s*(.+)$/);
            const normalized = match ? match[1].trim() : line;
            const classification = VALID_CLASSIFICATIONS.has(normalized)
                ? normalized
                : "observation";
            result.set(needsClassification[i].entry.memory.id, classification);
        }
    } catch (error) {
        logCodeRepoInboxWarning("code-repo.inbox.classify", error);
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

    const entityPrompt = await context.loadPrompt("entity-extraction");
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

async function batchDetectSupersession(
    decisions: OwnedMemory[],
    context: DomainContext,
): Promise<void> {
    const llm = context.llmAt("low");
    if (!llm.extractStructured) return;

    // Collect existing non-superseded decisions similar to new ones
    const existingMap = new Map<string, ScoredMemory>();
    const newDecisionIds = new Set(decisions.map((d) => d.memory.id));

    for (const decision of decisions) {
        const searchResult = await context.search({
            text: decision.memory.content,
            tags: [CODE_REPO_DECISION_TAG],
            minScore: 0.7,
        });

        for (const existing of searchResult.entries) {
            if (newDecisionIds.has(existing.id)) continue;
            const attrs = existing.domainAttributes[context.domain] as
                | Record<string, unknown>
                | undefined;
            if (attrs && !attrs.superseded) {
                existingMap.set(existing.id, existing);
            }
        }
    }

    const existingDecisions = [...existingMap.values()];
    if (existingDecisions.length === 0) return;

    const batches = buildSupersessionBatches(decisions, existingDecisions);

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
    const existingLengths = existingEntries.map((e) => e.content.length);
    const totalExistingLength = existingLengths.reduce((sum, l) => sum + l, 0);

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

    const supersessionPrompt = await context.loadPrompt("supersession");

    const newItems = newEntries.map((e, i) => `${i}. ${e.memory.content}`).join("\n");
    const existingItems = existingEntries.map((e) => `[${e.id}] ${e.content}`).join("\n");

    const prompt =
        supersessionPrompt +
        `\n\nNew entries:\n${newItems}\n\n` +
        `Existing entries:\n${existingItems}\n\n` +
        "Return only actual supersessions. If none exist, return an empty array.";

    try {
        const pairs = (await llm.extractStructured(
            prompt,
            BATCH_SUPERSESSION_SCHEMA,
            "Identify superseded decision pairs.",
        )) as Array<{ newIndex: number; existingId: string }>;

        for (const pair of pairs) {
            if (pair.newIndex < 0 || pair.newIndex >= newEntries.length) continue;
            const newMemoryId = newEntries[pair.newIndex].memory.id;
            const existing = existingEntries.find((e) => e.id === pair.existingId);
            if (!existing) continue;

            await context.graph.relate(newMemoryId, "supersedes", existing.id);
            await context.updateAttributes(existing.id, {
                ...existing.domainAttributes[context.domain],
                superseded: true,
                validUntil: Date.now(),
            });
        }
    } catch (error) {
        logCodeRepoInboxWarning("code-repo.inbox.supersessionDetection", error);
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
            tags: [CODE_REPO_TAG],
            minScore: 0.75,
        });

        for (const candidate of searchResult.entries) {
            if (newEntryIds.has(candidate.id)) continue;
            const attrs = candidate.domainAttributes[context.domain] as
                | Record<string, unknown>
                | undefined;
            if (attrs?.superseded) continue;
            relatedMap.set(candidate.id, candidate);
        }
    }

    const relatedEntries = [...relatedMap.values()];
    if (relatedEntries.length === 0) return;

    const relatedPrompt = await context.loadPrompt("related-knowledge");

    const newItems = entries
        .map(
            (e, i) =>
                `${i}. [${classificationMap.get(e.memory.id) ?? "observation"}] ${e.memory.content}`,
        )
        .join("\n");
    const existingItems = relatedEntries.map((e) => `[${e.id}] ${e.content}`).join("\n");

    const prompt =
        relatedPrompt +
        `\n\nNew entries:\n${newItems}\n\n` +
        `Existing entries:\n${existingItems}\n\n` +
        "Return only meaningful relationships. If none exist, return an empty array.";

    try {
        const relationships = (await llm.extractStructured(
            prompt,
            BATCH_RELATIONSHIP_SCHEMA,
            "Identify related code-repo entries.",
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
                // Best-effort
            }
        }
    } catch (error) {
        logCodeRepoInboxWarning("code-repo.inbox.relatedLinking", error);
    }
}
