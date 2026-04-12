import { StringRecordId } from "surrealdb";
import type { DomainContext } from "../../core/types.js";
import type { ChatDomainOptions } from "./types.js";
import {
    CHAT_TAG,
    CHAT_EPISODIC_TAG,
    CHAT_SEMANTIC_TAG,
    DEFAULT_WORKING_CAPACITY,
    DEFAULT_WORKING_MAX_AGE,
    DEFAULT_CONSOLIDATION_SIMILARITY,
    DEFAULT_CONSOLIDATION_MIN_CLUSTER,
    DEFAULT_SEMANTIC_DEDUP_THRESHOLD,
    DEFAULT_EPISODIC_LAMBDA,
    DEFAULT_PRUNE_THRESHOLD,
} from "./types.js";
import { countTokens } from "../../core/scoring.js";
import { ensureTag } from "./utils.js";

interface WorkingMemoryRow {
    in: string;
    attributes: Record<string, unknown>;
}

export async function promoteWorkingMemory(
    context: DomainContext,
    options?: ChatDomainOptions,
): Promise<void> {
    await context.debug.time("chat.schedule.promote", async () => {
        const capacity = options?.workingMemoryCapacity ?? DEFAULT_WORKING_CAPACITY;
        const maxAge = options?.workingMemoryMaxAge ?? DEFAULT_WORKING_MAX_AGE;

        const rows = await context.graph.query<WorkingMemoryRow[]>(
            'SELECT in, attributes FROM owned_by WHERE out = $domainId AND attributes.layer = "working"',
            { domainId: new StringRecordId(`domain:${context.domain}`) },
        );
        if (!rows || rows.length === 0) return;

        const groups = new Map<string, { memId: string; attrs: Record<string, unknown> }[]>();
        for (const row of rows) {
            const memId = String(row.in);
            const attrs = row.attributes;
            const userId = typeof attrs.userId === "string" ? attrs.userId : "";
            const chatSessionId =
                typeof attrs.chatSessionId === "string" ? attrs.chatSessionId : "";
            const key = `${userId}::${chatSessionId}`;

            let group = groups.get(key);
            if (!group) {
                group = [];
                groups.set(key, group);
            }
            group.push({ memId, attrs });
        }

        const now = Date.now();

        for (const group of groups.values()) {
            const toPromote: { memId: string; attrs: Record<string, unknown> }[] = [];

            group.sort((a, b) => {
                const idxA = (a.attrs.messageIndex as number) ?? 0;
                const idxB = (b.attrs.messageIndex as number) ?? 0;
                return idxA - idxB;
            });

            for (const item of group) {
                const memory = await context.getMemory(item.memId);
                if (memory && now - memory.createdAt > maxAge) {
                    toPromote.push(item);
                }
            }

            if (group.length > capacity) {
                const overCapacityCount = group.length - capacity;
                for (let i = 0; i < overCapacityCount; i++) {
                    if (!toPromote.some((p) => p.memId === group[i].memId)) {
                        toPromote.push(group[i]);
                    }
                }
            }

            if (toPromote.length === 0) continue;

            const contents: string[] = [];
            const promotedIds: string[] = [];
            for (const item of toPromote) {
                const memory = await context.getMemory(item.memId);
                if (memory) {
                    contents.push(memory.content);
                    promotedIds.push(item.memId);
                }
            }

            if (contents.length === 0) continue;

            const facts = await context.debug.time(
                "chat.schedule.promote.extractFacts",
                () => context.llmAt("low").extract(contents.join("\n")),
                { memories: promotedIds.length },
            );
            if (!facts || facts.length === 0) {
                for (const memId of promotedIds) {
                    await context.releaseOwnership(memId, context.domain);
                }
                continue;
            }

            const sampleAttrs = toPromote[0].attrs;
            const userId = typeof sampleAttrs.userId === "string" ? sampleAttrs.userId : "";
            const chatSessionId =
                typeof sampleAttrs.chatSessionId === "string" ? sampleAttrs.chatSessionId : "";

            const chatTagId = await ensureTag(context, CHAT_TAG);
            const episodicTagId = await ensureTag(context, CHAT_EPISODIC_TAG);
            try {
                await context.graph.relate(episodicTagId, "child_of", chatTagId);
            } catch {
                /* already related */
            }

            for (const fact of facts) {
                const episodicId = await context.writeMemory({
                    content: fact,
                    tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                    ownership: {
                        domain: context.domain,
                        attributes: {
                            layer: "episodic",
                            userId,
                            chatSessionId,
                            weight: 1.0,
                            validFrom: Date.now(),
                        },
                    },
                });

                for (const memId of promotedIds) {
                    await context.graph.relate(episodicId, "summarizes", memId);
                }
            }

            for (const memId of promotedIds) {
                await context.releaseOwnership(memId, context.domain);
            }
        }
    });
}

export async function consolidateEpisodic(
    context: DomainContext,
    options?: ChatDomainOptions,
): Promise<void> {
    await context.debug.time("chat.schedule.consolidate", async () => {
        const similarityThreshold =
            options?.consolidation?.similarityThreshold ?? DEFAULT_CONSOLIDATION_SIMILARITY;
        const minClusterSize =
            options?.consolidation?.minClusterSize ?? DEFAULT_CONSOLIDATION_MIN_CLUSTER;

        const episodicMemories = await context.getMemories({
            tags: [CHAT_EPISODIC_TAG],
            attributes: { layer: "episodic" },
        });

        if (episodicMemories.length < minClusterSize) return;

        const clustered = new Set<string>();
        const clusters: string[][] = [];

        for (const memory of episodicMemories) {
            if (clustered.has(memory.id)) continue;

            const searchResult = await context.search({
                text: memory.content,
                tags: [CHAT_EPISODIC_TAG],
                attributes: { layer: "episodic" },
                minScore: similarityThreshold,
            });

            const clusterMembers = searchResult.entries
                .filter((entry) => !clustered.has(entry.id))
                .map((entry) => entry.id);

            if (clusterMembers.length >= minClusterSize) {
                clusters.push(clusterMembers);
                for (const id of clusterMembers) {
                    clustered.add(id);
                }
            }
        }

        for (const cluster of clusters) {
            const clusterEntries: { id: string; content: string }[] = [];
            for (const memId of cluster) {
                const memory = await context.getMemory(memId);
                if (memory) {
                    clusterEntries.push({ id: memId, content: memory.content });
                }
            }

            if (clusterEntries.length === 0) continue;

            const contents = clusterEntries.map((e) => e.content);
            let summary: string | undefined;
            let contradictions: { newerIndex: number; olderIndex: number }[] = [];

            const llm = context.llmAt("medium");

            if (llm.extractStructured) {
                const schema = JSON.stringify({
                    type: "object",
                    properties: {
                        summary: {
                            type: "string",
                            description:
                                "A consolidated summary of the non-contradicted facts, preserving all important details",
                        },
                        contradictions: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    newerIndex: {
                                        type: "number",
                                        description:
                                            "0-based index of the newer fact that supersedes",
                                    },
                                    olderIndex: {
                                        type: "number",
                                        description:
                                            "0-based index of the older fact being contradicted",
                                    },
                                },
                                required: ["newerIndex", "olderIndex"],
                            },
                            description:
                                "Pairs where a newer fact contradicts or supersedes an older one about the same topic",
                        },
                    },
                    required: ["summary", "contradictions"],
                });

                const prompt = `Analyze the following numbered facts. Identify any where a newer fact (higher index) contradicts or supersedes an older fact (lower index) about the same topic. Then consolidate the non-contradicted facts into a single summary.\n\n${contents.map((c, i) => `${i}. ${c}`).join("\n")}`;

                try {
                    const result = await context.debug.time(
                        "chat.schedule.consolidate.structured",
                        () => llm.extractStructured!(prompt, schema),
                        { memories: contents.length },
                    );

                    if (result && result.length > 0) {
                        const parsed = result[0] as {
                            summary?: string;
                            contradictions?: { newerIndex: number; olderIndex: number }[];
                        };
                        summary = parsed.summary;
                        contradictions = parsed.contradictions ?? [];
                    }
                } catch {
                    // extractStructured failed — fall through to consolidate()
                }
            }

            // Fallback to plain consolidate if extractStructured unavailable or returned nothing
            if (!summary) {
                summary = await context.debug.time(
                    "chat.schedule.consolidate.summary",
                    () => context.llmAt("medium").consolidate(contents),
                    { memories: contents.length },
                );
            }

            if (!summary) continue;

            // Process contradictions — invalidate older memories
            const invalidatedIds = new Set<string>();
            const now = Date.now();

            for (const { newerIndex, olderIndex } of contradictions) {
                const older = clusterEntries[olderIndex];
                const newer = clusterEntries[newerIndex];
                if (!older || !newer) continue;

                // Read existing attributes and add invalidAt
                const attrRows = await context.graph.query<
                    { attributes: Record<string, unknown> }[]
                >("SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId", {
                    memId: new StringRecordId(older.id),
                    domainId: new StringRecordId(`domain:${context.domain}`),
                });
                if (attrRows && attrRows.length > 0) {
                    await context.updateAttributes(older.id, {
                        ...attrRows[0].attributes,
                        invalidAt: now,
                    });
                }

                // Create contradicts edge
                await context.graph.relate(newer.id, "contradicts", older.id, {
                    strength: 1.0,
                    detected_at: now,
                });

                invalidatedIds.add(older.id);
            }

            // Create semantic memory
            const chatTagId = await ensureTag(context, CHAT_TAG);
            const semanticTagId = await ensureTag(context, CHAT_SEMANTIC_TAG);
            try {
                await context.graph.relate(semanticTagId, "child_of", chatTagId);
            } catch {
                /* already related */
            }

            const semanticId = await context.writeMemory({
                content: summary,
                tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
                ownership: {
                    domain: context.domain,
                    attributes: {
                        layer: "semantic",
                        weight: 0.8,
                        validFrom: now,
                    },
                },
            });

            // Create summarizes edges only from non-invalidated cluster members
            for (const entry of clusterEntries) {
                if (!invalidatedIds.has(entry.id)) {
                    await context.graph.relate(semanticId, "summarizes", entry.id);
                }
            }

            // Semantic dedup: check for existing similar semantic memories
            const dedupThreshold =
                options?.consolidation?.semanticDedupThreshold ?? DEFAULT_SEMANTIC_DEDUP_THRESHOLD;

            const existingSemantics = await context.search({
                text: summary,
                tags: [CHAT_SEMANTIC_TAG],
                attributes: { layer: "semantic" },
                minScore: dedupThreshold,
            });

            // Filter out the semantic memory we just created, non-semantic layers,
            // and any already-invalidated ones
            const dedupCandidates = existingSemantics.entries.filter((e) => {
                if (e.id === semanticId) return false;
                const attrs = e.domainAttributes[context.domain];
                if (!attrs || attrs.layer !== "semantic") return false;
                if (attrs.invalidAt != null) return false;
                return true;
            });

            if (dedupCandidates.length > 0) {
                const dupTarget = dedupCandidates[0];

                // Merge via LLM consolidate
                const merged = await context.debug.time(
                    "chat.schedule.consolidate.semanticMerge",
                    () => context.llmAt("medium").consolidate([summary, dupTarget.content]),
                    { memories: 2 },
                );

                if (merged) {
                    // Update the new semantic memory with merged content
                    await context.graph.updateNode(semanticId, {
                        content: merged,
                        token_count: countTokens(merged),
                    });

                    // Invalidate the old semantic memory
                    const oldAttrRows = await context.graph.query<
                        { attributes: Record<string, unknown> }[]
                    >("SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId", {
                        memId: new StringRecordId(dupTarget.id),
                        domainId: new StringRecordId(`domain:${context.domain}`),
                    });
                    if (oldAttrRows && oldAttrRows.length > 0) {
                        await context.updateAttributes(dupTarget.id, {
                            ...oldAttrRows[0].attributes,
                            invalidAt: now,
                        });
                    }

                    // Create summarizes edge from merged → old
                    await context.graph.relate(semanticId, "summarizes", dupTarget.id);
                }
            }
        }
    });
}

export async function pruneDecayed(
    context: DomainContext,
    options?: ChatDomainOptions,
): Promise<void> {
    await context.debug.time("chat.schedule.prune", async () => {
        const lambda = options?.decay?.episodicLambda ?? DEFAULT_EPISODIC_LAMBDA;
        const threshold = options?.decay?.pruneThreshold ?? DEFAULT_PRUNE_THRESHOLD;

        const rows = await context.graph.query<WorkingMemoryRow[]>(
            'SELECT in, attributes FROM owned_by WHERE out = $domainId AND attributes.layer = "episodic"',
            { domainId: new StringRecordId(`domain:${context.domain}`) },
        );
        if (!rows || rows.length === 0) return;

        const now = Date.now();

        for (const row of rows) {
            const memId = String(row.in);
            const weight = typeof row.attributes.weight === "number" ? row.attributes.weight : 1.0;

            // Skip already-invalidated memories
            if (row.attributes.invalidAt != null) continue;

            const memory = await context.getMemory(memId);
            if (!memory) continue;

            const hoursSinceCreation = (now - memory.createdAt) / (1000 * 60 * 60);
            const decayedWeight = weight * Math.exp(-lambda * hoursSinceCreation);

            if (decayedWeight < threshold) {
                await context.releaseOwnership(memId, context.domain);
            }
        }
    });
}
