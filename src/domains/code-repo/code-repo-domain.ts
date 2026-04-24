import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { StringRecordId } from "surrealdb";
import type {
    DomainConfig,
    DomainRegistration,
    DomainSchedule,
    DomainContext,
    GraphApi,
    SearchQuery,
    ScoredMemory,
    ContextResult,
} from "../../core/types.js";
import { countTokens, cosineSimilarityF32 } from "../../core/scoring.js";
import { createTopicLinkingPlugin } from "../../plugins/topic-linking.js";
import {
    CODE_REPO_DOMAIN_ID,
    CODE_REPO_TAG,
    DEFAULT_SCAN_INTERVAL_MS,
    DEFAULT_DRIFT_INTERVAL_MS,
} from "./types.js";
import type { CodeRepoDomainOptions, MemoryClassification } from "./types.js";
import { codeRepoSkills } from "./skills.js";
import { processInboxBatch } from "./inbox.js";
import { scanCommits, detectDrift } from "./schedules.js";
import { bootstrapCodeRepo } from "./bootstrap.js";
import { isEntryValid, getCodeRepoAttrs, computeImportance, recordAccess } from "./utils.js";

async function llmRerankMemories(
    query: string,
    memories: ScoredMemory[],
    context: DomainContext,
): Promise<ScoredMemory[]> {
    if (memories.length === 0) return memories;
    const llm = context.llm;
    if (!llm.generate) return memories;

    const rerankPrompt = await context.loadPrompt("rerank");
    const numbered = memories.map((m, i) => `[${i}] ${m.content.substring(0, 200)}`).join("\n");

    const prompt = `Given the query: "${query}"\n\n${rerankPrompt}\n\nMemories:\n${numbered}`;

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
        return result.length > 0 ? result : memories;
    } catch {
        return memories;
    }
}

function buildSchedules(options?: CodeRepoDomainOptions): DomainSchedule[] {
    const schedules: DomainSchedule[] = [];
    const hasProjectRoot = !!options?.projectRoot;

    if (hasProjectRoot && options?.commitScanner?.enabled !== false) {
        schedules.push({
            id: "commit-scanner",
            name: "Scan recent commits for structural changes",
            intervalMs: options?.commitScanner?.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
            run: (context: DomainContext) => scanCommits(context, options),
        });
    }

    if (hasProjectRoot && options?.driftDetector?.enabled !== false) {
        schedules.push({
            id: "drift-detector",
            name: "Detect drift from recorded decisions",
            intervalMs: options?.driftDetector?.intervalMs ?? DEFAULT_DRIFT_INTERVAL_MS,
            run: (context: DomainContext) => detectDrift(context, options),
        });
    }

    return schedules;
}

export function createCodeRepoDomain(options?: CodeRepoDomainOptions): DomainRegistration {
    const domainId = options?.id ?? CODE_REPO_DOMAIN_ID;

    const domain: DomainConfig = {
        id: domainId,
        name: "Code Repo Knowledge",
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
                {
                    name: "module",
                    schemafull: false,
                    fields: [
                        { name: "name", type: "string" },
                        { name: "path", type: "string", required: false },
                        { name: "kind", type: "string", required: false },
                        { name: "status", type: "string", required: false, default: "active" },
                    ],
                },
                {
                    name: "data_entity",
                    schemafull: false,
                    fields: [
                        { name: "name", type: "string" },
                        { name: "source", type: "string", required: false },
                    ],
                },
                {
                    name: "concept",
                    schemafull: false,
                    fields: [
                        { name: "name", type: "string" },
                        { name: "description", type: "string", required: false },
                    ],
                },
                {
                    name: "pattern",
                    schemafull: false,
                    fields: [
                        { name: "name", type: "string" },
                        { name: "scope", type: "string", required: false },
                    ],
                },
            ],
            edges: [
                {
                    name: "about_entity",
                    from: "memory",
                    to: ["module", "data_entity", "concept", "pattern"],
                    fields: [{ name: "relevance", type: "float" }],
                },
                { name: "supersedes", from: "memory", to: "memory" },
                { name: "raises", from: "memory", to: "memory" },
                {
                    name: "related_knowledge",
                    from: "memory",
                    to: "memory",
                    fields: [{ name: "relationship", type: "string" }],
                },
                {
                    name: "connects_to",
                    from: "module",
                    to: "module",
                    fields: [
                        { name: "protocol", type: "string" },
                        { name: "direction", type: "string" },
                        { name: "description", type: "string" },
                    ],
                },
                {
                    name: "manages",
                    from: "module",
                    to: "data_entity",
                    fields: [{ name: "role", type: "string" }],
                },
                { name: "contains", from: "module", to: "module" },
                { name: "implements", from: "module", to: "concept" },
                {
                    name: "has_field",
                    from: "data_entity",
                    to: "data_entity",
                    fields: [{ name: "cardinality", type: "string" }],
                },
            ],
        },
        skills: codeRepoSkills,
        processInboxBatch,
        schedules: buildSchedules(options),
        bootstrap: (context: DomainContext) => bootstrapCodeRepo(context, options),
        tunableParams: [
            { name: "minScore", default: 0.5, min: -1, max: 0.8, step: 0.05 },
            { name: "embeddingRerank", default: 1, min: 0, max: 1, step: 1 },
            { name: "llmRerank", default: 0, min: 0, max: 1, step: 1 },
            { name: "decayFactor", default: 0.95, min: 0.5, max: 1.0, step: 0.05 },
            { name: "importanceBoost", default: 1.5, min: 1.0, max: 3.0, step: 0.25 },
            { name: "mmrLambda", default: 1.0, min: 0.3, max: 1.0, step: 0.05 },
            { name: "useQuestionSearch", default: 0, min: 0, max: 1, step: 1 },
        ],

        describe() {
            return "Built-in code repo knowledge domain that captures the invisible knowledge layer around a codebase: architectural decisions and rationale, business logic semantics, design direction, and relationships between system components.";
        },

        search: {
            async expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
                if (!query.text) return query;

                // Search for entity nodes matching query terms
                const entityTypes = ["module", "data_entity", "concept", "pattern"];
                const matchedEntityIds: string[] = [];

                for (const type of entityTypes) {
                    try {
                        const results = await context.graph.query<Array<{ id: string }>>(
                            `SELECT id FROM type::table($type) WHERE name CONTAINS $text LIMIT 5`,
                            { type, text: query.text },
                        );
                        if (Array.isArray(results)) {
                            matchedEntityIds.push(...results.map((r) => String(r.id)));
                        }
                    } catch {
                        // Entity type may not exist yet
                    }
                }

                if (matchedEntityIds.length === 0) return query;

                // Add traversal hints to find memories linked to matched entities
                return {
                    ...query,
                    traversal: {
                        from: matchedEntityIds,
                        pattern: "<-about_entity<-memory.*",
                        depth: 1,
                    },
                };
            },

            rank(_query: SearchQuery, candidates: ScoredMemory[]): ScoredMemory[] {
                const now = Date.now();
                return candidates
                    .map((c) => {
                        const attrs = getCodeRepoAttrs(c.domainAttributes, domainId);
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

            const audience = context.requestContext.audience as string | undefined;

            const minScore = context.getTunableParam("minScore") ?? 0.5;
            const useEmbeddingRerank = (context.getTunableParam("embeddingRerank") ?? 1) > 0;
            const useLlmRerank = (context.getTunableParam("llmRerank") ?? 0) > 0;
            const mmrLambda = context.getTunableParam("mmrLambda") ?? 1.0;
            const useQuestionSearch = (context.getTunableParam("useQuestionSearch") ?? 0) > 0;

            const now = Date.now();

            const results = await context.search({
                text,
                tags: [CODE_REPO_TAG],
                minScore,
                rerank: useEmbeddingRerank,
                rerankThreshold: minScore,
                tokenBudget: budgetTokens * 3,
            });

            let entries = results.entries.filter((e) => {
                const attrs = getCodeRepoAttrs(e.domainAttributes, domainId);
                if (!isEntryValid(attrs, now)) return false;
                return matchesAudience(attrs, audience);
            });

            if (entries.length === 0) return empty;

            // Step 1: Question search
            if (useQuestionSearch) {
                entries = await mergeQuestionSearch(entries, text, context, audience, domainId);
            }

            // Step 2: Keyword search — catches entries embedding rerank dropped
            entries = await mergeKeywordSearch(entries, text, context, audience, domainId);

            // Step 3: Optional LLM rerank
            if (useLlmRerank && context.llm) {
                entries = await llmRerankMemories(text, entries, context);
            }

            // Step 4: Resolve decomposed children to parents
            const resolved = await resolveToParents(entries, context, now, domainId);

            // Step 5: Deduplicate near-duplicate content
            const { entries: deduped, aliases: dedupAliases } = deduplicateByContent(resolved, 0.5);

            // Step 6: MMR-based budget fill
            const selected = await mmrBudgetFill(
                deduped,
                budgetTokens,
                mmrLambda,
                context.graph,
                domainId,
            );

            if (selected.length === 0) return empty;

            // Group selected entries by classification for formatted output
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

            const decisions = [
                ...(groups.get("decision") ?? []),
                ...(groups.get("rationale") ?? []),
            ];
            if (decisions.length > 0) {
                sections.push(`[Decisions]\n${decisions.map((e) => e.content).join("\n")}`);
                allMemories.push(...decisions);
            }

            const architecture = [
                ...(groups.get("direction") ?? []),
                ...(groups.get("clarification") ?? []),
            ];
            if (architecture.length > 0) {
                sections.push(`[Architecture]\n${architecture.map((e) => e.content).join("\n")}`);
                allMemories.push(...architecture);
            }

            const observations = [
                ...(groups.get("observation") ?? []),
                ...(groups.get("question") ?? []),
            ];
            if (observations.length > 0) {
                sections.push(
                    `[Recent Observations]\n${observations.map((e) => e.content).join("\n")}`,
                );
                allMemories.push(...observations);
            }

            // Prepend core memories
            const core = await context.getCoreMemories();
            if (core.length > 0) {
                sections.unshift(`[Instructions]\n${core.map((m) => m.content).join("\n")}`);
            }

            const finalContext = sections.join("\n\n");

            // Include dedup aliases — entries whose content is represented by a surviving entry
            const selectedIds = new Set(allMemories.map((m) => m.id));
            for (const [aliasId, survivorId] of dedupAliases) {
                if (selectedIds.has(survivorId)) {
                    const survivor = allMemories.find((m) => m.id === survivorId);
                    if (survivor) {
                        allMemories.push({ ...survivor, id: aliasId });
                    }
                }
            }

            // Fire-and-forget access tracking
            Promise.all(
                allMemories.map((m) =>
                    recordAccess(
                        context,
                        m.id,
                        getCodeRepoAttrs(m.domainAttributes, domainId),
                    ).catch(() => {}),
                ),
            ).catch(() => {});

            return {
                context: finalContext,
                memories: allMemories,
                totalTokens: countTokens(finalContext),
            };
        },
    };

    return {
        domain,
        plugins: [createTopicLinkingPlugin()],
        requires: ["topic-linking"],
    };
}

/**
 * Checks if a memory's audience attribute includes the requested audience.
 * If no audience filter is requested, all memories match.
 */
function matchesAudience(
    attrs: Record<string, unknown> | undefined,
    requestedAudience: string | undefined,
): boolean {
    if (!requestedAudience) return true;
    if (!attrs) return false;
    const memAudience = attrs.audience;
    if (Array.isArray(memAudience)) {
        return memAudience.includes(requestedAudience);
    }
    return memAudience === requestedAudience;
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

interface DedupResult {
    entries: ScoredMemory[];
    aliases: Map<string, string>;
}

function deduplicateByContent(entries: ScoredMemory[], threshold: number): DedupResult {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    const accepted: Array<{ mem: ScoredMemory; words: Set<string> }> = [];
    const aliases = new Map<string, string>();

    for (const entry of sorted) {
        const words = extractWordSet(entry.content);
        const match = accepted.find((a) => jaccardSimilarity(a.words, words) >= threshold);
        if (match) {
            aliases.set(entry.id, match.mem.id);
        } else {
            accepted.push({ mem: entry, words });
        }
    }

    return { entries: accepted.map((a) => a.mem), aliases };
}

/**
 * Resolves decomposed child entries back to their parent documents.
 */
async function resolveToParents(
    entries: ScoredMemory[],
    context: DomainContext,
    now: number,
    domainId: string,
): Promise<ScoredMemory[]> {
    const parentMap = new Map<string, { mem: ScoredMemory; bestScore: number }>();
    const standalone: ScoredMemory[] = [];

    for (const entry of entries) {
        const attrs = getCodeRepoAttrs(entry.domainAttributes);
        const parentId = attrs?.parentMemoryId as string | undefined;

        if (!parentId) {
            standalone.push(entry);
            continue;
        }

        const existing = parentMap.get(parentId);
        if (existing) {
            if (entry.score > existing.bestScore) {
                existing.bestScore = entry.score;
                existing.mem = { ...existing.mem, score: entry.score };
            }
            continue;
        }

        const parentMemory = await context.getMemory(parentId);
        if (!parentMemory) {
            standalone.push(entry);
            continue;
        }

        const parentDomainRef = new StringRecordId(`domain:${domainId}`);
        const parentMemRef = new StringRecordId(parentId);
        const attrRows = await context.graph.query<Array<{ attributes: Record<string, unknown> }>>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId LIMIT 1",
            {
                memId: parentMemRef,
                domainId: parentDomainRef,
            },
        );

        const parentAttrs = attrRows?.[0]?.attributes ?? {};
        if (parentAttrs.superseded) continue;
        if (typeof parentAttrs.validUntil === "number" && parentAttrs.validUntil < now) continue;

        const parentScored: ScoredMemory = {
            id: parentMemory.id,
            content: parentMemory.content,
            score: entry.score,
            scores: {},
            tags: [],
            domainAttributes: { [domainId]: parentAttrs },
            eventTime: parentMemory.eventTime,
            createdAt: parentMemory.createdAt,
            tokenCount: parentMemory.tokenCount,
        };

        parentMap.set(parentId, { mem: parentScored, bestScore: entry.score });
    }

    const parentIds = new Set(parentMap.keys());
    const deduped = standalone.filter((e) => !parentIds.has(e.id));

    return [...deduped, ...[...parentMap.values()].map((p) => p.mem)];
}

type MemoryQueryRow = {
    id: unknown;
    content: string;
    event_time: number | null;
    created_at: number;
    token_count?: number;
};

const STOP_WORDS = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "out",
    "off",
    "over",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "because",
    "but",
    "and",
    "or",
    "if",
    "while",
    "what",
    "which",
    "who",
    "whom",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "i",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "he",
    "him",
    "his",
    "she",
    "her",
    "they",
    "them",
    "their",
    "about",
    "up",
    "down",
    "also",
    "still",
    "already",
]);

async function mergeKeywordSearch(
    entries: ScoredMemory[],
    queryText: string,
    context: DomainContext,
    audience: string | undefined,
    domainId: string,
): Promise<ScoredMemory[]> {
    const now = Date.now();

    const keywords = queryText
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    if (keywords.length === 0) return entries;

    try {
        const allRows = new Map<string, MemoryQueryRow>();
        const matchCounts = new Map<string, number>();

        for (const kw of keywords) {
            const rows = await context.graph.query<MemoryQueryRow[]>(
                `SELECT * FROM memory WHERE string::contains(string::lowercase(content), $kw) LIMIT 20`,
                { kw },
            );
            if (!rows) continue;
            for (const row of rows) {
                const id = String(row.id);
                allRows.set(id, row);
                matchCounts.set(id, (matchCounts.get(id) ?? 0) + 1);
            }
        }

        if (allRows.size === 0) return entries;

        const minMatches = 1;
        const rows = [...allRows.entries()]
            .filter(([id]) => (matchCounts.get(id) ?? 0) >= minMatches)
            .map(([, row]) => row);

        if (rows.length === 0) return entries;

        const existingMap = new Map(entries.map((e) => [e.id, e]));
        const newIds = rows.map((r) => String(r.id)).filter((id) => !existingMap.has(id));

        if (newIds.length === 0) {
            for (const row of rows) {
                const existing = existingMap.get(String(row.id));
                if (existing) existing.score *= 1.3;
            }
            return entries;
        }

        // Fetch ownership attributes + filter by code-repo domain and audience
        const attrMap = new Map<string, Record<string, Record<string, unknown>>>();
        const surrealIds = newIds.map((id) =>
            id.startsWith("memory:") ? new StringRecordId(id) : new StringRecordId(`memory:${id}`),
        );
        const ownershipEdges = await context.graph.query<
            Array<{ in: unknown; out: unknown; attributes: Record<string, unknown> }>
        >("SELECT in, out, attributes FROM owned_by WHERE in IN $ids", {
            ids: surrealIds,
        });
        if (ownershipEdges) {
            for (const edge of ownershipEdges) {
                const memId = String(edge.in);
                const domainId = String(edge.out).replace("domain:", "");
                if (!attrMap.has(memId)) attrMap.set(memId, {});
                attrMap.get(memId)![domainId] = edge.attributes ?? {};
            }
        }

        const newEntries: ScoredMemory[] = [];
        for (const row of rows) {
            const id = String(row.id);
            const existing = existingMap.get(id);
            if (existing) {
                existing.score *= 1.3;
                continue;
            }

            const domainAttributes = attrMap.get(id) ?? {};
            const codeRepoAttrs = domainAttributes[domainId] as Record<string, unknown> | undefined;
            // Only include memories owned by code-repo
            if (!codeRepoAttrs) continue;
            if (!isEntryValid(codeRepoAttrs, now)) continue;
            if (!matchesAudience(codeRepoAttrs, audience)) continue;

            const mc = matchCounts.get(id) ?? 0;
            const score = mc / keywords.length;

            newEntries.push({
                id,
                content: row.content,
                score,
                scores: { fulltext: score },
                tags: [],
                domainAttributes,
                eventTime: row.event_time ?? null,
                createdAt: row.created_at,
                tokenCount: row.token_count,
            });
        }

        return [...entries, ...newEntries];
    } catch {
        return entries;
    }
}

async function mergeQuestionSearch(
    entries: ScoredMemory[],
    queryText: string,
    context: DomainContext,
    audience: string | undefined,
    domainId: string,
): Promise<ScoredMemory[]> {
    const now = Date.now();

    try {
        const rows = await context.graph.query<Array<MemoryQueryRow & { score: number }>>(
            `SELECT *, search::score(1) AS score FROM memory
             WHERE answers_question @1@ $text
             ORDER BY score DESC
             LIMIT 20`,
            { text: queryText },
        );

        if (!rows || rows.length === 0) return entries;

        const existingMap = new Map(entries.map((e) => [e.id, e]));
        const newIds: string[] = [];
        const topScore = rows[0].score || 1;

        for (const row of rows) {
            const id = String(row.id);
            const existing = existingMap.get(id);
            if (existing) {
                existing.score *= 1.5;
            } else {
                newIds.push(id);
            }
        }

        if (newIds.length === 0) return entries;

        const attrMap = new Map<string, Record<string, Record<string, unknown>>>();
        const surrealIds = newIds.map((id) =>
            id.startsWith("memory:") ? new StringRecordId(id) : new StringRecordId(`memory:${id}`),
        );
        const ownershipEdges = await context.graph.query<
            Array<{ in: unknown; out: unknown; attributes: Record<string, unknown> }>
        >("SELECT in, out, attributes FROM owned_by WHERE in IN $ids", {
            ids: surrealIds,
        });
        if (ownershipEdges) {
            for (const edge of ownershipEdges) {
                const memId = String(edge.in);
                const domainId = String(edge.out).replace("domain:", "");
                if (!attrMap.has(memId)) attrMap.set(memId, {});
                attrMap.get(memId)![domainId] = edge.attributes ?? {};
            }
        }

        const newEntries: ScoredMemory[] = [];
        for (const row of rows) {
            const id = String(row.id);
            if (existingMap.has(id)) continue;

            const domainAttributes = attrMap.get(id) ?? {};
            const codeRepoAttrs = domainAttributes[domainId] as Record<string, unknown> | undefined;
            if (!codeRepoAttrs) continue;
            if (!isEntryValid(codeRepoAttrs, now)) continue;
            if (!matchesAudience(codeRepoAttrs, audience)) continue;

            const normalizedScore = 0.2 * ((row.score || 0) / topScore);

            newEntries.push({
                id,
                content: row.content,
                score: normalizedScore,
                scores: { fulltext: normalizedScore },
                tags: [],
                domainAttributes,
                eventTime: row.event_time ?? null,
                createdAt: row.created_at,
                tokenCount: row.token_count,
            });
        }

        return [...entries, ...newEntries];
    } catch {
        return entries;
    }
}

async function mmrBudgetFill(
    candidates: ScoredMemory[],
    budgetTokens: number,
    lambda: number,
    graph: GraphApi,
    domainId: string,
): Promise<Array<{ mem: ScoredMemory; classification: MemoryClassification }>> {
    if (candidates.length === 0) return [];

    const classify = (mem: ScoredMemory): MemoryClassification => {
        const attrs = getCodeRepoAttrs(mem.domainAttributes, domainId);
        return (attrs?.classification as MemoryClassification) ?? "observation";
    };

    if (lambda >= 1.0) {
        const sorted = [...candidates].sort((a, b) => b.score - a.score);
        const result: Array<{ mem: ScoredMemory; classification: MemoryClassification }> = [];
        let usedTokens = 0;
        for (const entry of sorted) {
            const tokens = countTokens(entry.content);
            if (usedTokens + tokens > budgetTokens) continue;
            usedTokens += tokens;
            result.push({ mem: entry, classification: classify(entry) });
        }
        return result;
    }

    const embeddingMap = await fetchEmbeddings(
        candidates.map((c) => c.id),
        graph,
    );
    const embeddingMapF32 = new Map<string, Float32Array>();
    for (const [id, emb] of embeddingMap) {
        embeddingMapF32.set(id, Float32Array.from(emb));
    }

    const remaining = candidates.map((c, i) => ({ entry: c, idx: i }));
    const selected: Array<{ mem: ScoredMemory; classification: MemoryClassification }> = [];
    const selectedEmbeddings: Float32Array[] = [];
    let usedTokens = 0;

    while (remaining.length > 0) {
        let bestIdx = -1;
        let bestMmr = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const { entry } = remaining[i];
            const tokens = countTokens(entry.content);
            if (usedTokens + tokens > budgetTokens) continue;

            const relevance = entry.score;
            let maxSim = 0;

            if (selectedEmbeddings.length > 0) {
                const emb = embeddingMapF32.get(entry.id);
                if (emb) {
                    for (const sel of selectedEmbeddings) {
                        const sim = cosineSimilarityF32(emb, sel);
                        if (sim > maxSim) maxSim = sim;
                    }
                }
            }

            const mmr = lambda * relevance - (1 - lambda) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) break;

        const { entry } = remaining[bestIdx];
        const tokens = countTokens(entry.content);
        usedTokens += tokens;

        selected.push({ mem: entry, classification: classify(entry) });

        const emb = embeddingMapF32.get(entry.id);
        if (emb) selectedEmbeddings.push(emb);

        remaining.splice(bestIdx, 1);
    }

    return selected;
}

async function fetchEmbeddings(ids: string[], graph: GraphApi): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    if (ids.length === 0) return map;

    const surrealIds = ids.map((id) =>
        id.startsWith("memory:") ? new StringRecordId(id) : new StringRecordId(`memory:${id}`),
    );

    try {
        const rows = await graph.query<Array<{ id: unknown; embedding: number[] }>>(
            `SELECT id, embedding FROM memory WHERE id IN $ids`,
            { ids: surrealIds },
        );

        if (rows) {
            for (const row of rows) {
                if (row.embedding) {
                    map.set(String(row.id), row.embedding);
                }
            }
        }
    } catch {
        // If embedding fetch fails, MMR degrades to greedy (no diversity penalty)
    }

    return map;
}

const codeRepoRegistration = createCodeRepoDomain();
export const codeRepoDomain = codeRepoRegistration.domain;
