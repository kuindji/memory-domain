import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { StringRecordId } from "surrealdb";
import type {
    DomainConfig,
    DomainSchedule,
    DomainContext,
    GraphApi,
    SearchQuery,
    ScoredMemory,
    ContextResult,
} from "../../core/types.js";
import { countTokens } from "../../core/scoring.js";
import { TOPIC_TAG } from "../topic/types.js";
import {
    KB_DOMAIN_ID,
    KB_DEFINITION_TAG,
    KB_CONCEPT_TAG,
    KB_FACT_TAG,
    KB_REFERENCE_TAG,
    KB_HOWTO_TAG,
    KB_INSIGHT_TAG,
    DEFAULT_CONSOLIDATE_INTERVAL_MS,
} from "./types.js";
import type { KbDomainOptions } from "./types.js";
import { kbSkills } from "./skills.js";
import { processInboxBatch } from "./inbox.js";
import { consolidateKnowledge } from "./schedules.js";

async function findMatchingTopicMemoryIds(text: string, graph: GraphApi): Promise<string[]> {
    try {
        const words = text
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 3);
        if (words.length === 0) return [];

        const topicTagId = new StringRecordId(`tag:${TOPIC_TAG}`);
        // Find topic nodes whose content contains any of the keywords
        const results = await graph.query<Array<{ id: string; content: string }>>(
            `SELECT in as id, (SELECT content FROM ONLY $parent.in).content as content FROM tagged WHERE out = $tagId`,
            { tagId: topicTagId },
        );
        if (!Array.isArray(results) || results.length === 0) return [];

        return results
            .filter((r) => {
                const content = (r.content ?? "").toLowerCase();
                return words.some((w) => content.includes(w));
            })
            .map((r) => String(r.id));
    } catch {
        return [];
    }
}

async function getMemoryIdsForTopics(topicIds: string[], graph: GraphApi): Promise<Set<string>> {
    if (topicIds.length === 0) return new Set();
    try {
        const topicRecordIds = topicIds.map((id) => new StringRecordId(id));
        const results = await graph.query<Array<{ memId: string }>>(
            `SELECT in as memId FROM about_topic WHERE out IN $topicIds`,
            { topicIds: topicRecordIds },
        );
        if (!Array.isArray(results)) return new Set();
        return new Set(results.map((r) => String(r.memId)));
    } catch {
        return new Set();
    }
}

function buildSchedules(options?: KbDomainOptions): DomainSchedule[] {
    const schedules: DomainSchedule[] = [];

    if (options?.consolidateSchedule?.enabled !== false) {
        schedules.push({
            id: "consolidate-knowledge",
            name: "Consolidate overlapping knowledge entries",
            intervalMs: options?.consolidateSchedule?.intervalMs ?? DEFAULT_CONSOLIDATE_INTERVAL_MS,
            run: (context: DomainContext) => consolidateKnowledge(context),
        });
    }

    return schedules;
}

export function createKbDomain(options?: KbDomainOptions): DomainConfig {
    return {
        id: KB_DOMAIN_ID,
        name: "Knowledge Base",
        baseDir: dirname(fileURLToPath(import.meta.url)),
        schema: {
            nodes: [],
            edges: [
                { name: "supersedes", from: "memory", to: "memory" },
                {
                    name: "related_knowledge",
                    from: "memory",
                    to: "memory",
                    fields: [{ name: "relationship", type: "string" }],
                },
            ],
        },
        skills: kbSkills,
        processInboxBatch,
        schedules: buildSchedules(options),
        tunableParams: [
            { name: "minScore", default: 0.3, min: 0.05, max: 0.8, step: 0.05 },
            { name: "definitionBudgetPct", default: 0.3, min: 0.1, max: 0.6, step: 0.05 },
            { name: "factBudgetPct", default: 0.4, min: 0.1, max: 0.6, step: 0.05 },
            { name: "topicBoostFactor", default: 1.5, min: 1.0, max: 3.0, step: 0.25 },
            { name: "topicPenaltyFactor", default: 0.5, min: 0.1, max: 1.0, step: 0.1 },
        ],

        describe() {
            return "General-purpose knowledge base domain for storing domain-agnostic knowledge: facts, definitions, how-tos, technical references, concepts, and insights. A personal wiki not tied to any specific project or conversation.";
        },

        search: {
            async expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
                if (!query.text) return query;

                try {
                    const topicIds = await findMatchingTopicMemoryIds(query.text, context.graph);
                    if (topicIds.length === 0) return query;
                    return {
                        ...query,
                        traversal: {
                            from: topicIds,
                            pattern: "<-about_topic<-memory.*",
                            depth: 1,
                        },
                    };
                } catch {
                    return query;
                }
            },

            rank(_query: SearchQuery, candidates: ScoredMemory[]): ScoredMemory[] {
                return candidates
                    .map((c) => {
                        const attrs = c.domainAttributes[KB_DOMAIN_ID] as
                            | Record<string, unknown>
                            | undefined;
                        let score = c.score;
                        if (attrs?.superseded) score *= 0.1;
                        return { ...c, score };
                    })
                    .sort((a, b) => b.score - a.score);
            },
        },

        async buildContext(
            text: string,
            budgetTokens: number,
            context: DomainContext,
        ): Promise<ContextResult> {
            const empty: ContextResult = { context: "", memories: [], totalTokens: 0 };
            if (!text) return empty;

            const minScore = context.getTunableParam("minScore") ?? 0.3;
            const defPct = context.getTunableParam("definitionBudgetPct") ?? 0.3;
            const factPct = context.getTunableParam("factBudgetPct") ?? 0.4;
            const howtoPct = Math.max(0.1, 1.0 - defPct - factPct);
            const topicBoost = context.getTunableParam("topicBoostFactor") ?? 1.5;
            const topicPenalty = context.getTunableParam("topicPenaltyFactor") ?? 0.5;

            const definitionBudget = Math.floor(budgetTokens * defPct);
            const factBudget = Math.floor(budgetTokens * factPct);
            const howtoBudget = Math.floor(budgetTokens * howtoPct);

            const allMemories: ScoredMemory[] = [];
            const sections: string[] = [];

            // Resolve topics matching the query text for score boosting
            const topicIds = await findMatchingTopicMemoryIds(text, context.graph);
            const topicMemoryIds = await getMemoryIdsForTopics(topicIds, context.graph);
            const hasTopicFilter = topicMemoryIds.size > 0;

            // Section 1 — [Definitions & Concepts]
            for (const tag of [KB_DEFINITION_TAG, KB_CONCEPT_TAG]) {
                const result = await context.search({
                    text,
                    tags: [tag],
                    tokenBudget: definitionBudget,
                    minScore,
                });

                const entries = result.entries.filter((e) => {
                    const attrs = e.domainAttributes[KB_DOMAIN_ID];
                    return !attrs?.superseded;
                });
                allMemories.push(...entries);
            }

            if (hasTopicFilter) {
                applyTopicBoost(allMemories, topicMemoryIds, topicBoost, topicPenalty);
            }

            const definitionMemories = deduplicateMemories(allMemories);
            if (definitionMemories.length > 0) {
                const lines = truncateToTokenBudget(definitionMemories, definitionBudget);
                if (lines.length > 0) {
                    sections.push(`[Definitions & Concepts]\n${lines.join("\n")}`);
                }
            }

            // Section 2 — [Facts & References]
            for (const tag of [KB_FACT_TAG, KB_REFERENCE_TAG]) {
                const result = await context.search({
                    text,
                    tags: [tag],
                    tokenBudget: factBudget,
                    minScore,
                });

                const entries = result.entries.filter((e) => {
                    if (allMemories.some((m) => m.id === e.id)) return false;
                    const attrs = e.domainAttributes[KB_DOMAIN_ID];
                    return !attrs?.superseded;
                });
                if (hasTopicFilter) {
                    applyTopicBoost(entries, topicMemoryIds, topicBoost, topicPenalty);
                }
                allMemories.push(...entries);
            }

            const factMemories = allMemories.filter(
                (m) => !definitionMemories.some((d) => d.id === m.id),
            );
            const dedupedFacts = deduplicateMemories(factMemories);
            if (dedupedFacts.length > 0) {
                const lines = truncateToTokenBudget(dedupedFacts, factBudget);
                if (lines.length > 0) {
                    sections.push(`[Facts & References]\n${lines.join("\n")}`);
                }
            }

            // Section 3 — [How-Tos & Insights]
            for (const tag of [KB_HOWTO_TAG, KB_INSIGHT_TAG]) {
                const result = await context.search({
                    text,
                    tags: [tag],
                    tokenBudget: howtoBudget,
                    minScore,
                });

                const entries = result.entries.filter((e) => {
                    if (allMemories.some((m) => m.id === e.id)) return false;
                    const attrs = e.domainAttributes[KB_DOMAIN_ID];
                    return !attrs?.superseded;
                });

                if (hasTopicFilter) {
                    applyTopicBoost(entries, topicMemoryIds, topicBoost, topicPenalty);
                }

                if (entries.length > 0) {
                    const lines = truncateToTokenBudget(entries, howtoBudget);
                    if (lines.length > 0) {
                        sections.push(`[How-Tos & Insights]\n${lines.join("\n")}`);
                        allMemories.push(...entries);
                    }
                }
            }

            const finalContext = sections.join("\n\n");
            const totalTokens = countTokens(finalContext);

            return {
                context: finalContext,
                memories: deduplicateMemories(allMemories),
                totalTokens,
            };
        },
    };
}

function deduplicateMemories(memories: ScoredMemory[]): ScoredMemory[] {
    const seen = new Set<string>();
    const result: ScoredMemory[] = [];
    for (const mem of memories) {
        if (!seen.has(mem.id)) {
            seen.add(mem.id);
            result.push(mem);
        }
    }
    return result;
}

function applyTopicBoost(
    memories: ScoredMemory[],
    topicMemoryIds: Set<string>,
    boostFactor: number,
    penaltyFactor: number,
): void {
    for (let i = 0; i < memories.length; i++) {
        const mem = memories[i];
        if (topicMemoryIds.has(mem.id)) {
            memories[i] = { ...mem, score: mem.score * boostFactor };
        } else {
            memories[i] = { ...mem, score: mem.score * penaltyFactor };
        }
    }
    memories.sort((a, b) => b.score - a.score);
}

function truncateToTokenBudget(memories: ScoredMemory[], budget: number): string[] {
    const lines: string[] = [];
    let tokens = 0;
    for (const mem of memories) {
        const t = countTokens(mem.content);
        if (tokens + t > budget) break;
        tokens += t;
        lines.push(mem.content);
    }
    return lines;
}

export const kbDomain = createKbDomain();
