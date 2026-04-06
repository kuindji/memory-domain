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
    LLMAdapter,
} from "../../core/types.js";
import { countTokens } from "../../core/scoring.js";
import { TOPIC_TAG } from "../topic/types.js";
import {
    KB_DOMAIN_ID,
    KB_TAG,
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
import { isEntryValid, getKbAttrs, recordAccess, computeImportance } from "./utils.js";

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

async function llmRerankMemories(
    query: string,
    memories: ScoredMemory[],
    llm: LLMAdapter,
): Promise<ScoredMemory[]> {
    if (memories.length === 0) return memories;
    if (!llm.generate) return memories;

    const numbered = memories.map((m, i) => `[${i}] ${m.content.substring(0, 200)}`).join("\n");

    const prompt = `Given the query: "${query}"

Score each memory's relevance (0-5). Only include memories scoring 3+.

Memories:
${numbered}

Respond with ONLY a JSON array of objects: [{"index": 0, "score": 5}, ...]
Include only memories with score >= 3.`;

    try {
        const response = await llm.generate(prompt);
        const match = response.match(/\[[\s\S]*\]/);
        if (!match) return memories;

        const scores = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
        const result: ScoredMemory[] = [];

        for (const s of scores) {
            if (s.index >= 0 && s.index < memories.length && s.score >= 3) {
                result.push({ ...memories[s.index], score: s.score / 5 });
            }
        }

        result.sort((a, b) => b.score - a.score);

        // Fallback: if LLM filtered everything, return original
        return result.length > 0 ? result : memories;
    } catch {
        return memories;
    }
}

async function tryFullContextReturn(
    budgetTokens: number,
    context: DomainContext,
): Promise<ContextResult | null> {
    const allEntries = await context.getMemories({
        tags: [KB_TAG],
        attributes: { superseded: false },
    });

    // Quick token count — bail early if over budget
    let totalTokens = 0;
    for (const entry of allEntries) {
        totalTokens += entry.tokenCount;
        if (totalTokens > budgetTokens) return null;
    }

    if (allEntries.length === 0) return null;

    // Fetch domain attributes for all entries in a single batch query
    const now = Date.now();
    const domainRef = new StringRecordId(`domain:${KB_DOMAIN_ID}`);
    const memRefs = allEntries.map((e) => new StringRecordId(e.id));
    const attrRows = await context.graph.query<
        Array<{ in: string; attributes: Record<string, unknown> }>
    >("SELECT in, attributes FROM owned_by WHERE in IN $memIds AND out = $domainId", {
        memIds: memRefs,
        domainId: domainRef,
    });

    const attrMap = new Map<string, Record<string, unknown>>();
    if (attrRows) {
        for (const row of attrRows) {
            attrMap.set(String(row.in), row.attributes);
        }
    }

    const groups = new Map<string, Array<{ content: string; mem: ScoredMemory }>>();
    const allMemories: ScoredMemory[] = [];

    for (const entry of allEntries) {
        const attrs = attrMap.get(entry.id);
        if (!isEntryValid(attrs, now)) continue;

        const cls = (attrs?.classification as string) ?? "fact";
        const scored: ScoredMemory = {
            id: entry.id,
            content: entry.content,
            score: 1.0,
            scores: {},
            tags: [],
            domainAttributes: { [KB_DOMAIN_ID]: attrs ?? {} },
            eventTime: entry.eventTime,
            createdAt: entry.createdAt,
            tokenCount: entry.tokenCount,
        };

        let group = groups.get(cls);
        if (!group) {
            group = [];
            groups.set(cls, group);
        }
        group.push({ content: entry.content, mem: scored });
        allMemories.push(scored);
    }

    const sections: string[] = [];
    const defConcept = [...(groups.get("definition") ?? []), ...(groups.get("concept") ?? [])];
    if (defConcept.length > 0) {
        sections.push(`[Definitions & Concepts]\n${defConcept.map((e) => e.content).join("\n")}`);
    }

    const factRef = [...(groups.get("fact") ?? []), ...(groups.get("reference") ?? [])];
    if (factRef.length > 0) {
        sections.push(`[Facts & References]\n${factRef.map((e) => e.content).join("\n")}`);
    }

    const howtoInsight = [...(groups.get("how-to") ?? []), ...(groups.get("insight") ?? [])];
    if (howtoInsight.length > 0) {
        sections.push(`[How-Tos & Insights]\n${howtoInsight.map((e) => e.content).join("\n")}`);
    }

    const finalContext = sections.join("\n\n");

    // Record access for importance tracking
    Promise.all(
        allMemories.map((m) =>
            recordAccess(context, m.id, getKbAttrs(m.domainAttributes)).catch(() => {}),
        ),
    ).catch(() => {});

    return {
        context: finalContext,
        memories: allMemories,
        totalTokens: countTokens(finalContext),
    };
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
            { name: "minScore", default: 0.5, min: -1, max: 0.8, step: 0.05 },
            { name: "definitionBudgetPct", default: 0.3, min: 0.1, max: 0.6, step: 0.05 },
            { name: "factBudgetPct", default: 0.4, min: 0.1, max: 0.6, step: 0.05 },
            { name: "topicBoostFactor", default: 1.5, min: 1.0, max: 3.0, step: 0.25 },
            { name: "embeddingRerank", default: 1, min: 0, max: 1, step: 1 },
            { name: "llmRerank", default: 0, min: 0, max: 1, step: 1 },
            { name: "decayFactor", default: 0.95, min: 0.5, max: 1.0, step: 0.05 },
            { name: "importanceBoost", default: 1.5, min: 1.0, max: 3.0, step: 0.25 },
            { name: "adaptiveContext", default: 1, min: 0, max: 1, step: 1 },
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
                const now = Date.now();
                return candidates
                    .map((c) => {
                        const attrs = getKbAttrs(c.domainAttributes);
                        let score = c.score;
                        if (!isEntryValid(attrs, now)) {
                            score *= 0.05;
                        } else {
                            const imp = computeImportance(attrs, 0.95);
                            score *= 1 + (imp - 0.5) * 0.5;
                        }
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

            const minScore = context.getTunableParam("minScore") ?? 0.5;
            const defPct = context.getTunableParam("definitionBudgetPct") ?? 0.3;
            const factPct = context.getTunableParam("factBudgetPct") ?? 0.4;
            const howtoPct = Math.max(0.1, 1.0 - defPct - factPct);
            const topicBoost = context.getTunableParam("topicBoostFactor") ?? 1.5;
            const useEmbeddingRerank = (context.getTunableParam("embeddingRerank") ?? 1) > 0;
            const useLlmRerank = (context.getTunableParam("llmRerank") ?? 0) > 0;

            const definitionBudget = Math.floor(budgetTokens * defPct);
            const factBudget = Math.floor(budgetTokens * factPct);
            const howtoBudget = Math.floor(budgetTokens * howtoPct);

            const allMemories: ScoredMemory[] = [];
            const sections: string[] = [];
            const now = Date.now();

            // Resolve topics matching the query text for score boosting
            const topicIds = await findMatchingTopicMemoryIds(text, context.graph);
            const topicMemoryIds = await getMemoryIdsForTopics(topicIds, context.graph);
            const hasTopicFilter = topicMemoryIds.size > 0;

            // Adaptive context: if KB is small enough and no topic filtering needed,
            // return everything grouped by classification
            const useAdaptiveContext = (context.getTunableParam("adaptiveContext") ?? 1) > 0;
            if (useAdaptiveContext && !hasTopicFilter) {
                const fullResult = await tryFullContextReturn(budgetTokens, context);
                if (fullResult) return fullResult;
            }

            // Track best non-topic memory as fallback (used only if all topic-filtering yields nothing)
            let bestNonTopicFallback: ScoredMemory | null = null;

            // Section 1 — [Definitions & Concepts]
            const rawDefinitions: ScoredMemory[] = [];
            for (const tag of [KB_DEFINITION_TAG, KB_CONCEPT_TAG]) {
                const result = await context.search({
                    text,
                    tags: [tag],
                    tokenBudget: definitionBudget,
                    minScore,
                    rerank: useEmbeddingRerank,
                    rerankThreshold: minScore,
                });

                const entries = result.entries.filter((e) => {
                    return isEntryValid(getKbAttrs(e.domainAttributes), now);
                });
                rawDefinitions.push(...entries);
            }

            let filteredAll = rawDefinitions;
            if (hasTopicFilter) {
                filteredAll = applyTopicFilter(rawDefinitions, topicMemoryIds, topicBoost);
                const dropped = rawDefinitions.filter((m) => !topicMemoryIds.has(m.id));
                if (dropped.length > 0 && !bestNonTopicFallback) {
                    bestNonTopicFallback = dropped[0];
                }
            }
            allMemories.push(...filteredAll);

            const definitionMemories = deduplicateMemories(filteredAll);
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
                    rerank: useEmbeddingRerank,
                    rerankThreshold: minScore,
                });

                const entries = result.entries.filter((e) => {
                    if (allMemories.some((m) => m.id === e.id)) return false;
                    return isEntryValid(getKbAttrs(e.domainAttributes), now);
                });
                let filteredEntries = entries;
                if (hasTopicFilter) {
                    filteredEntries = applyTopicFilter(entries, topicMemoryIds, topicBoost);
                    const dropped = entries.filter((m) => !topicMemoryIds.has(m.id));
                    if (dropped.length > 0 && !bestNonTopicFallback) {
                        bestNonTopicFallback = dropped[0];
                    }
                }
                allMemories.push(...filteredEntries);
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
                    rerank: useEmbeddingRerank,
                    rerankThreshold: minScore,
                });

                const entries = result.entries.filter((e) => {
                    if (allMemories.some((m) => m.id === e.id)) return false;
                    return isEntryValid(getKbAttrs(e.domainAttributes), now);
                });

                let filteredHowto = entries;
                if (hasTopicFilter) {
                    filteredHowto = applyTopicFilter(entries, topicMemoryIds, topicBoost);
                    const dropped = entries.filter((m) => !topicMemoryIds.has(m.id));
                    if (dropped.length > 0 && !bestNonTopicFallback) {
                        bestNonTopicFallback = dropped[0];
                    }
                }

                if (filteredHowto.length > 0) {
                    const lines = truncateToTokenBudget(filteredHowto, howtoBudget);
                    if (lines.length > 0) {
                        sections.push(`[How-Tos & Insights]\n${lines.join("\n")}`);
                        allMemories.push(...filteredHowto);
                    }
                }
            }

            // Fallback: if topic filtering left nothing, keep the single best non-topic memory
            if (hasTopicFilter && allMemories.length === 0 && bestNonTopicFallback) {
                allMemories.push(bestNonTopicFallback);
                sections.push(bestNonTopicFallback.content);
            }

            // LLM re-rank: filter memories by semantic relevance
            if (useLlmRerank) {
                const allCollected = deduplicateMemories(allMemories);
                const reranked = await llmRerankMemories(text, allCollected, context.llm);

                if (reranked.length < allCollected.length) {
                    // Rebuild context from reranked memories only
                    sections.length = 0;
                    const rerankedDefs = reranked.filter((m) =>
                        definitionMemories.some((d) => d.id === m.id),
                    );
                    if (rerankedDefs.length > 0) {
                        const lines = truncateToTokenBudget(rerankedDefs, definitionBudget);
                        if (lines.length > 0) {
                            sections.push(`[Definitions & Concepts]\n${lines.join("\n")}`);
                        }
                    }

                    const rerankedFacts = reranked.filter(
                        (m) =>
                            !rerankedDefs.some((d) => d.id === m.id) &&
                            dedupedFacts.some((f) => f.id === m.id),
                    );
                    if (rerankedFacts.length > 0) {
                        const lines = truncateToTokenBudget(rerankedFacts, factBudget);
                        if (lines.length > 0) {
                            sections.push(`[Facts & References]\n${lines.join("\n")}`);
                        }
                    }

                    const rerankedOther = reranked.filter(
                        (m) =>
                            !rerankedDefs.some((d) => d.id === m.id) &&
                            !rerankedFacts.some((f) => f.id === m.id),
                    );
                    if (rerankedOther.length > 0) {
                        const lines = truncateToTokenBudget(rerankedOther, howtoBudget);
                        if (lines.length > 0) {
                            sections.push(`[How-Tos & Insights]\n${lines.join("\n")}`);
                        }
                    }

                    const finalContext = sections.join("\n\n");
                    const totalTokens = countTokens(finalContext);
                    return {
                        context: finalContext,
                        memories: reranked,
                        totalTokens,
                    };
                }
            }

            const finalContext = sections.join("\n\n");
            const totalTokens = countTokens(finalContext);
            const finalMemories = deduplicateMemories(allMemories);

            // Fire-and-forget access recording for importance tracking
            Promise.all(
                finalMemories.map((m) =>
                    recordAccess(context, m.id, getKbAttrs(m.domainAttributes)).catch(() => {}),
                ),
            ).catch(() => {});

            return {
                context: finalContext,
                memories: finalMemories,
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

function applyTopicFilter(
    memories: ScoredMemory[],
    topicMemoryIds: Set<string>,
    boostFactor: number,
): ScoredMemory[] {
    const topicMatches = memories.filter((m) => topicMemoryIds.has(m.id));

    const boosted = topicMatches.map((m) => ({ ...m, score: m.score * boostFactor }));
    boosted.sort((a, b) => b.score - a.score);
    return boosted;
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
