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
import { KB_DOMAIN_ID, KB_TAG, DEFAULT_CONSOLIDATE_INTERVAL_MS } from "./types.js";
import type { KbDomainOptions, QueryIntent } from "./types.js";
import { kbSkills } from "./skills.js";
import { processInboxBatch } from "./inbox.js";
import { consolidateKnowledge } from "./schedules.js";
import {
    isEntryValid,
    getKbAttrs,
    recordAccess,
    computeImportance,
    classifyQueryIntent,
    ALL_CLASSIFICATIONS,
} from "./utils.js";

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

export function createKbDomain(options?: KbDomainOptions): DomainConfig {
    return {
        id: KB_DOMAIN_ID,
        name: "Knowledge Base",
        baseDir: dirname(fileURLToPath(import.meta.url)),
        schema: {
            nodes: [
                {
                    name: "memory",
                    fields: [
                        { name: "classification", type: "option<string>" },
                        { name: "topics", type: "option<array<string>>" },
                    ],
                    indexes: [
                        { name: "idx_memory_classification", fields: ["classification"] },
                        { name: "idx_memory_topics", fields: ["topics"] },
                    ],
                },
            ],
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
            { name: "embeddingRerank", default: 1, min: 0, max: 1, step: 1 },
            { name: "llmRerank", default: 0, min: 0, max: 1, step: 1 },
            { name: "decayFactor", default: 0.95, min: 0.5, max: 1.0, step: 0.05 },
            { name: "importanceBoost", default: 1.5, min: 1.0, max: 3.0, step: 0.25 },
            { name: "useQueryIntent", default: 1, min: 0, max: 1, step: 1 },
        ],

        async bootstrap(context: DomainContext) {
            // Backfill classification/topics from owned_by attributes for existing entries
            const domainRef = new StringRecordId(`domain:${KB_DOMAIN_ID}`);
            const rows = await context.graph.query<
                Array<{ in: string; attributes: Record<string, unknown> }>
            >(
                `SELECT in, attributes FROM owned_by WHERE out = $domainId AND in.classification IS NONE`,
                { domainId: domainRef },
            );

            if (!rows || rows.length === 0) return;

            for (const row of rows) {
                const cls = row.attributes?.classification as string | undefined;
                if (!cls) continue;

                const updates: Record<string, unknown> = { classification: cls };

                // Try to get topics from about_topic edges
                const topicRows = await context.graph.query<Array<{ content: string }>>(
                    `SELECT (SELECT content FROM ONLY $parent.out).content AS content FROM about_topic WHERE in = $memId`,
                    { memId: new StringRecordId(row.in) },
                );
                if (topicRows && topicRows.length > 0) {
                    updates.topics = topicRows
                        .map((t) => t.content)
                        .filter((c) => typeof c === "string" && c.length > 0);
                }

                await context.graph.query(
                    "UPDATE $memId SET classification = $cls, topics = $topics",
                    {
                        memId: new StringRecordId(row.in),
                        cls: updates.classification,
                        topics: updates.topics ?? [],
                    },
                );
            }
        },

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
            const useEmbeddingRerank = (context.getTunableParam("embeddingRerank") ?? 1) > 0;
            const useLlmRerank = (context.getTunableParam("llmRerank") ?? 0) > 0;
            const useIntent = (context.getTunableParam("useQueryIntent") ?? 1) > 0;

            // Step 1: Classify query intent
            let intent: QueryIntent | null = null;
            if (useIntent) {
                intent = await classifyQueryIntent(text, context.llmAt("low"));
            }

            const now = Date.now();

            // Step 2: Build filters from intent
            const filters: Record<string, unknown> = {};
            if (intent && intent.classifications.length < ALL_CLASSIFICATIONS.length) {
                filters.classification = intent.classifications;
            }
            if (intent?.topic) {
                filters.topics = { containsAny: [intent.topic] };
            }

            // Step 3: Search with filters
            const searchText = intent?.keywords?.length ? intent.keywords.join(" ") : text;
            const results = await context.search({
                text: searchText,
                tags: [KB_TAG],
                minScore,
                rerank: useEmbeddingRerank,
                rerankThreshold: minScore,
                filters: Object.keys(filters).length > 0 ? filters : undefined,
                tokenBudget: budgetTokens * 3, // Over-fetch to have candidates for parent resolution
            });

            let entries = results.entries.filter((e) =>
                isEntryValid(getKbAttrs(e.domainAttributes), now),
            );

            // Step 4: Progressive fallback if too few results
            const MIN_RESULTS = 3;
            if (entries.length < MIN_RESULTS && Object.keys(filters).length > 0) {
                const widerResults = await context.search({
                    text,
                    tags: [KB_TAG],
                    minScore,
                    rerank: useEmbeddingRerank,
                    rerankThreshold: minScore,
                    tokenBudget: budgetTokens * 3,
                });
                entries = widerResults.entries.filter((e) =>
                    isEntryValid(getKbAttrs(e.domainAttributes), now),
                );
            }

            if (entries.length === 0) return empty;

            // Step 5: Optional LLM rerank
            if (useLlmRerank && context.llm) {
                entries = await llmRerankMemories(text, entries, context.llm);
            }

            // Step 6: Resolve children to parents
            const resolved = await resolveToParents(entries, context, now);

            // Step 7: Deduplicate near-duplicate content
            const deduped = deduplicateByContent(resolved, 0.5);

            // Step 8: Relevance-first budget — fill by score, then group for output
            deduped.sort((a, b) => b.score - a.score);

            const selected: Array<{ mem: ScoredMemory; classification: string }> = [];
            let usedTokens = 0;
            for (const entry of deduped) {
                const tokens = countTokens(entry.content);
                if (usedTokens + tokens > budgetTokens) continue;
                usedTokens += tokens;

                const attrs = getKbAttrs(entry.domainAttributes);
                const cls = (attrs?.classification as string) ?? "fact";
                selected.push({ mem: entry, classification: cls });
            }

            if (selected.length === 0) return empty;

            // Step 8: Group selected entries by classification for formatted output
            const groups = new Map<string, ScoredMemory[]>();
            for (const { mem, classification } of selected) {
                let group = groups.get(classification);
                if (!group) {
                    group = [];
                    groups.set(classification, group);
                }
                group.push(mem);
            }

            const sections: string[] = [];
            const allMemories: ScoredMemory[] = [];

            const defConcept = [
                ...(groups.get("definition") ?? []),
                ...(groups.get("concept") ?? []),
            ];
            if (defConcept.length > 0) {
                sections.push(
                    `[Definitions & Concepts]\n${defConcept.map((e) => e.content).join("\n")}`,
                );
                allMemories.push(...defConcept);
            }

            const factRef = [...(groups.get("fact") ?? []), ...(groups.get("reference") ?? [])];
            if (factRef.length > 0) {
                sections.push(`[Facts & References]\n${factRef.map((e) => e.content).join("\n")}`);
                allMemories.push(...factRef);
            }

            const howtoInsight = [
                ...(groups.get("how-to") ?? []),
                ...(groups.get("insight") ?? []),
            ];
            if (howtoInsight.length > 0) {
                sections.push(
                    `[How-Tos & Insights]\n${howtoInsight.map((e) => e.content).join("\n")}`,
                );
                allMemories.push(...howtoInsight);
            }

            const finalContext = sections.join("\n\n");

            // Record access for importance tracking (fire-and-forget)
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
        },
    };
}

function extractWordSet(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2),
    );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const word of a) {
        if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
}

/**
 * Removes near-duplicate entries by word-overlap similarity.
 * Entries are processed in score order — higher-scored entries are kept.
 */
function deduplicateByContent(entries: ScoredMemory[], threshold: number): ScoredMemory[] {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    const accepted: Array<{ mem: ScoredMemory; words: Set<string> }> = [];

    for (const entry of sorted) {
        const words = extractWordSet(entry.content);
        const isDuplicate = accepted.some((a) => jaccardSimilarity(a.words, words) >= threshold);
        if (!isDuplicate) {
            accepted.push({ mem: entry, words });
        }
    }

    return accepted.map((a) => a.mem);
}

/**
 * Resolves child entries (from decomposition) back to their parent documents.
 * When multiple children from the same parent match, the parent gets the highest child score.
 * Standalone entries (no parent) pass through unchanged.
 */
async function resolveToParents(
    entries: ScoredMemory[],
    context: DomainContext,
    now: number,
): Promise<ScoredMemory[]> {
    // Map: parentId → { parentMemory, bestScore }
    const parentMap = new Map<string, { mem: ScoredMemory; bestScore: number }>();
    const standalone: ScoredMemory[] = [];

    for (const entry of entries) {
        const attrs = getKbAttrs(entry.domainAttributes);
        const parentId = attrs?.parentMemoryId as string | undefined;

        if (!parentId) {
            standalone.push(entry);
            continue;
        }

        const existing = parentMap.get(parentId);
        if (existing) {
            // Multiple children from same parent — keep best score
            if (entry.score > existing.bestScore) {
                existing.bestScore = entry.score;
                existing.mem = { ...existing.mem, score: entry.score };
            }
            continue;
        }

        // Fetch parent memory
        const parentMemory = await context.getMemory(parentId);
        if (!parentMemory) {
            // Parent not found — keep the child as fallback
            standalone.push(entry);
            continue;
        }

        // Fetch parent's domain attributes
        const parentDomainRef = new StringRecordId(`domain:${KB_DOMAIN_ID}`);
        const parentMemRef = new StringRecordId(parentId);
        const attrRows = await context.graph.query<Array<{ attributes: Record<string, unknown> }>>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId LIMIT 1",
            {
                memId: parentMemRef,
                domainId: parentDomainRef,
            },
        );

        const parentAttrs = attrRows?.[0]?.attributes ?? {};

        // Check parent validity (superseded/expired but NOT decomposed — that's expected)
        if (parentAttrs.superseded) continue;
        if (typeof parentAttrs.validUntil === "number" && parentAttrs.validUntil < now) continue;

        const parentScored: ScoredMemory = {
            id: parentMemory.id,
            content: parentMemory.content,
            score: entry.score,
            scores: {},
            tags: [],
            domainAttributes: { [KB_DOMAIN_ID]: parentAttrs },
            eventTime: parentMemory.eventTime,
            createdAt: parentMemory.createdAt,
            tokenCount: parentMemory.tokenCount,
        };

        parentMap.set(parentId, { mem: parentScored, bestScore: entry.score });
    }

    // Deduplicate: standalone entries that are also resolved as parents
    const parentIds = new Set(parentMap.keys());
    const deduped = standalone.filter((e) => !parentIds.has(e.id));

    return [...deduped, ...[...parentMap.values()].map((p) => p.mem)];
}

export const kbDomain = createKbDomain();
