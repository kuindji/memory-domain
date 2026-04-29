import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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
import { KB_DOMAIN_ID, KB_TAG, DEFAULT_CONSOLIDATE_INTERVAL_MS } from "./types.js";
import type { KbDomainOptions } from "./types.js";
import { kbSkills } from "./skills.js";
import { processInboxBatch } from "./inbox.js";
import { consolidateKnowledge } from "./schedules.js";
import { isEntryValid, getKbAttrs, recordAccess, computeImportance } from "./utils.js";

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

const KB_BASE_DIR = dirname(fileURLToPath(import.meta.url));

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

        // Fallback: if LLM filtered everything, return original
        return result.length > 0 ? result : memories;
    } catch {
        return memories;
    }
}

export function createKbDomain(options?: KbDomainOptions): DomainRegistration {
    const domainId = options?.id ?? KB_DOMAIN_ID;

    const domain: DomainConfig = {
        id: domainId,
        name: "Knowledge Base",
        baseDir: KB_BASE_DIR,
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
            { name: "mmrLambda", default: 1.0, min: 0.3, max: 1.0, step: 0.05 },
            { name: "useQuestionSearch", default: 0, min: 0, max: 1, step: 1 },
        ],

        async bootstrap(context: DomainContext) {
            // Backfill classification from owned_by attributes for existing entries
            const rows = await context.graph.query<{
                in_id: string;
                attributes: Record<string, unknown>;
            }>(
                `SELECT ob.in_id, ob.attributes
                 FROM owned_by ob
                 JOIN memory m ON m.id = ob.in_id
                 WHERE ob.out_id = $1 AND m.classification IS NULL`,
                [`domain:${domainId}`],
            );

            if (!rows || rows.length === 0) return;

            for (const row of rows) {
                const cls = row.attributes?.classification as string | undefined;
                if (!cls) continue;

                await context.graph.query("UPDATE memory SET classification = $1 WHERE id = $2", [
                    cls,
                    row.in_id,
                ]);
            }
        },

        describe() {
            return "General-purpose knowledge base domain for storing domain-agnostic knowledge: facts, definitions, how-tos, technical references, concepts, and insights. A personal wiki not tied to any specific project or conversation.";
        },

        search: {
            rank(_query: SearchQuery, candidates: ScoredMemory[]): ScoredMemory[] {
                const now = Date.now();
                return candidates
                    .map((c) => {
                        const attrs = getKbAttrs(c.domainAttributes, domainId);
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
            const mmrLambda = context.getTunableParam("mmrLambda") ?? 1.0;
            const useQuestionSearch = (context.getTunableParam("useQuestionSearch") ?? 0) > 0;

            const now = Date.now();

            // Search with original text, no intent filters.
            // Classification at 54% accuracy hurts more than it helps as a search filter.
            // Classification is used for output grouping via stored attributes instead.
            //
            // Note on thresholds: framework-level `minScore` and `rerankThreshold`
            // are deliberately set low (0) so the kb pipeline gets the full
            // candidate set. The tunable `minScore` is then applied here, after
            // the supplemental keyword/question/topic-graph merges have run, so
            // graph candidates and atomic-fact embedding hits in the 0.3-0.5
            // range survive long enough to be reranked by their best signal.
            // rerankByEmbedding REPLACES candidate scores with raw query-content
            // cosine, so passing minScore=0.5 directly into the framework chops
            // every short-fact memory the model needs — that's the regression
            // that drove the 2.44/5 eval at default tuning.
            const results = await context.search({
                text,
                tags: [KB_TAG],
                minScore: 0,
                rerank: useEmbeddingRerank,
                rerankThreshold: 0,
                tokenBudget: budgetTokens * 3,
            });

            let entries = results.entries.filter((e) =>
                isEntryValid(getKbAttrs(e.domainAttributes, domainId), now),
            );

            if (entries.length === 0) return empty;

            // Step 4.5a: Question search — matches query against LLM-generated questions
            if (useQuestionSearch) {
                entries = await mergeQuestionSearch(entries, text, context, domainId);
            }

            // Step 4.5b: Keyword search — catches entries the embedding rerank missed
            entries = await mergeKeywordSearch(entries, text, context, domainId);

            // Step 4.5c: Topic-graph search — pulls in entries linked to topics
            // matching the query keywords. The topic-linking plugin's expandSearch
            // already does this at framework level, but those graph candidates get
            // killed by hybrid mergeScores (penalizeMissing) and the embedding
            // rerank threshold. Running it here as a supplemental merge bypasses
            // both gates, the same way mergeKeywordSearch and mergeQuestionSearch do.
            entries = await mergeTopicGraphSearch(entries, text, context, domainId);

            // Step 5: Optional LLM rerank
            if (useLlmRerank && context.llm) {
                entries = await llmRerankMemories(text, entries, context);
            }

            // Step 6: Resolve children to parents
            const resolved = await resolveToParents(entries, context, now, domainId);

            // Step 7: Deduplicate near-duplicate content
            const { entries: deduped, aliases: dedupAliases } = deduplicateByContent(resolved, 0.5);

            // Step 8: MMR-based budget fill — balances relevance with diversity
            const selected = await mmrBudgetFill(
                deduped,
                budgetTokens,
                mmrLambda,
                context.graph,
                domainId,
            );

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

            // Record access for importance tracking (fire-and-forget)
            Promise.all(
                allMemories.map((m) =>
                    recordAccess(context, m.id, getKbAttrs(m.domainAttributes, domainId)).catch(
                        () => {},
                    ),
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
    /** Maps removed entry ID → surviving entry ID that absorbed it */
    aliases: Map<string, string>;
}

/**
 * Removes near-duplicate entries by word-overlap similarity.
 * Entries are processed in score order — higher-scored entries are kept.
 * Returns alias map so callers can track which entries were collapsed.
 */
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
 * Resolves child entries (from decomposition) back to their parent documents.
 * When multiple children from the same parent match, the parent gets the highest child score.
 * Standalone entries (no parent) pass through unchanged.
 */
async function resolveToParents(
    entries: ScoredMemory[],
    context: DomainContext,
    now: number,
    domainId: string,
): Promise<ScoredMemory[]> {
    // Map: parentId → { parentMemory, bestScore }
    const parentMap = new Map<string, { mem: ScoredMemory; bestScore: number }>();
    const standalone: ScoredMemory[] = [];

    for (const entry of entries) {
        const attrs = getKbAttrs(entry.domainAttributes, domainId);
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
        const attrRows = await context.graph.query<{ attributes: Record<string, unknown> }>(
            "SELECT attributes FROM owned_by WHERE in_id = $1 AND out_id = $2 LIMIT 1",
            [parentId, `domain:${domainId}`],
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
            domainAttributes: { [domainId]: parentAttrs },
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

type MemoryQueryRow = {
    id: unknown;
    content: string;
    event_time: number | null;
    created_at: number;
    token_count?: number;
};

/**
 * Keyword-based supplemental search. Extracts discriminating keywords from the
 * query (words that appear infrequently in typical text) and searches for entries
 * containing those keywords via CONTAINS. This catches entries that the embedding
 * reranker dropped despite having exact keyword matches.
 */
async function mergeKeywordSearch(
    entries: ScoredMemory[],
    queryText: string,
    context: DomainContext,
    domainId: string = KB_DOMAIN_ID,
): Promise<ScoredMemory[]> {
    const now = Date.now();
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
        "longer",
        "no longer",
        "exist",
        "exists",
        "give",
        "gives",
        "given",
        "take",
        "takes",
        "taken",
        "make",
        "makes",
        "made",
        "work",
        "works",
        "different",
        "like",
        "know",
        "get",
        "got",
        "tell",
        "walk",
    ]);

    const keywords = queryText
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    if (keywords.length === 0) return entries;

    try {
        // Run per-keyword queries to ensure rare keywords get their own results
        const allRows = new Map<string, MemoryQueryRow>();
        const matchCounts = new Map<string, number>();

        for (const kw of keywords) {
            const rows = await context.graph.query<MemoryQueryRow>(
                `SELECT * FROM memory
                 WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
                 LIMIT 20`,
                [kw],
            );
            if (!rows) continue;
            for (const row of rows) {
                const id = String(row.id);
                allRows.set(id, row);
                matchCounts.set(id, (matchCounts.get(id) ?? 0) + 1);
            }
        }

        if (allRows.size === 0) return entries;

        // Allow single-keyword matches — scoring (mc/keywords.length) naturally
        // ranks multi-keyword matches higher, and MMR budget fill handles noise.
        // Requiring 2+ matches filters out decomposed children that individually
        // match only one concept keyword (e.g., "deprecated") from cross-cutting queries.
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

        const attrMap = new Map<string, Record<string, Record<string, unknown>>>();
        const normalizedIds = newIds.map((id) => (id.startsWith("memory:") ? id : `memory:${id}`));
        const ownershipEdges = await context.graph.query<{
            in_id: string;
            out_id: string;
            attributes: Record<string, unknown>;
        }>("SELECT in_id, out_id, attributes FROM owned_by WHERE in_id = ANY($1::text[])", [
            normalizedIds,
        ]);
        if (ownershipEdges) {
            for (const edge of ownershipEdges) {
                const memId = edge.in_id;
                const ownerDomain = edge.out_id.replace(/^domain:/, "");
                if (!attrMap.has(memId)) attrMap.set(memId, {});
                attrMap.get(memId)![ownerDomain] = edge.attributes ?? {};
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
            if (!isEntryValid(getKbAttrs(domainAttributes, domainId), now)) continue;

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

const TOPIC_SEARCH_STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "to", "of", "in", "for", "on",
    "with", "at", "by", "from", "as", "and", "or", "if", "but", "what",
    "which", "who", "whom", "this", "that", "these", "those", "it", "its",
    "how", "why", "when", "where", "all", "any", "some", "such", "no", "not",
    "about", "tell", "list", "show", "give", "explain",
]);

/**
 * Topic-graph supplemental search. The topic-linking plugin owns the
 * about_topic edge and registers a framework-level expandSearch that adds
 * a graph traversal to the SearchQuery; however, in hybrid mode those
 * graph-only candidates lose to the merged-score floor (penalizeMissing
 * divides graph weight 0.2 by the full weight sum 1.0, yielding 0.2 — below
 * minScore=0.5) and to rerankByEmbedding, which replaces score with raw
 * cosine to the query and drops anything under threshold. The whole point
 * of graph candidates is to bypass embedding similarity, so the rerank gate
 * destroys the mechanism. Running the same traversal here as a supplemental
 * merge — like mergeKeywordSearch and mergeQuestionSearch — lets these
 * entries land in MMR budget fill at a modest base score without touching
 * framework code or affecting other consumers of topic-linking.
 */
async function mergeTopicGraphSearch(
    entries: ScoredMemory[],
    queryText: string,
    context: DomainContext,
    domainId: string = KB_DOMAIN_ID,
): Promise<ScoredMemory[]> {
    const now = Date.now();

    const keywords = queryText
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !TOPIC_SEARCH_STOP_WORDS.has(w));

    if (keywords.length === 0) return entries;

    try {
        // Find topic-tagged memories whose content matches any query keyword.
        // ILIKE-OR keeps the SurrealDB-era semantics — substring match, not
        // tsvector — because topic names are short (1-3 words) and stemming
        // hurts more than it helps on them.
        const ilikeClauses = keywords.map((_, i) => `lower(m.content) LIKE $${i + 1}`);
        const ilikeValues = keywords.map((kw) => `%${kw}%`);

        const topicRows = await context.graph.query<{ id: string }>(
            `SELECT m.id
             FROM memory m
             JOIN tagged tg ON tg.in_id = m.id
             WHERE tg.out_id = 'tag:topic'
               AND (${ilikeClauses.join(" OR ")})
             LIMIT 50`,
            ilikeValues,
        );

        if (!topicRows || topicRows.length === 0) return entries;

        const topicIds = topicRows.map((r) => String(r.id));

        // Traverse about_topic edges: in_id = memory, out_id = topic. So
        // memories "about" the matching topics have out_id IN topicIds.
        // Restrict to memories owned by the kb domain (the same
        // `domainId` parameter used elsewhere) so cross-domain leakage
        // doesn't pollute kb retrieval.
        const linkedRows = await context.graph.query<{
            id: string;
            content: string;
            event_time: number | null;
            created_at: number;
            token_count: number | null;
            attributes: Record<string, unknown> | null;
            match_count: number;
        }>(
            `SELECT m.id, m.content, m.event_time, m.created_at, m.token_count,
                    ob.attributes,
                    COUNT(DISTINCT at.out_id)::int AS match_count
             FROM memory m
             JOIN about_topic at ON at.in_id = m.id
             JOIN owned_by ob ON ob.in_id = m.id AND ob.out_id = $1
             WHERE at.out_id = ANY($2::text[])
             GROUP BY m.id, m.content, m.event_time, m.created_at, m.token_count, ob.attributes
             ORDER BY match_count DESC
             LIMIT 50`,
            [`domain:${domainId}`, topicIds],
        );

        if (!linkedRows || linkedRows.length === 0) return entries;

        const existingMap = new Map(entries.map((e) => [e.id, e]));
        const topicMatchCount = topicIds.length;
        const newEntries: ScoredMemory[] = [];

        for (const row of linkedRows) {
            const id = String(row.id);
            // Score reflects how many of the query's matching topics this
            // memory is linked to. Capped at 0.7 so existing vector/fulltext
            // hits (often 0.5-1.0) still win when they're genuinely better,
            // but graph candidates clear the 0.5 minScore implied for kb.
            const matchRatio = Math.min(1, row.match_count / Math.max(1, topicMatchCount));
            const baseScore = 0.5 + 0.2 * matchRatio;

            const existing = existingMap.get(id);
            if (existing) {
                // Boost entries already in the candidate set — multi-signal
                // wins (vector + topic graph) should rank above single-signal.
                existing.score = Math.max(existing.score, existing.score * 1.3);
                existing.scores = { ...existing.scores, graph: baseScore };
                continue;
            }

            const domainAttributes = row.attributes
                ? { [domainId]: row.attributes }
                : {};
            if (!isEntryValid(getKbAttrs(domainAttributes, domainId), now)) continue;

            newEntries.push({
                id,
                content: row.content,
                score: baseScore,
                scores: { graph: baseScore },
                tags: [],
                domainAttributes,
                eventTime: row.event_time ?? null,
                createdAt: row.created_at,
                tokenCount: row.token_count ?? undefined,
            });
        }

        return [...entries, ...newEntries];
    } catch {
        return entries;
    }
}

/**
 * Searches the answers_question fulltext index to find entries whose
 * LLM-generated question matches the user's query. Merges results with
 * existing candidates, boosting dual-matched entries.
 */
async function mergeQuestionSearch(
    entries: ScoredMemory[],
    queryText: string,
    context: DomainContext,
    domainId: string = KB_DOMAIN_ID,
): Promise<ScoredMemory[]> {
    const now = Date.now();

    try {
        const rows = await context.graph.query<MemoryQueryRow & { score: number }>(
            `SELECT m.*, ts_rank(to_tsvector('english', coalesce(m.answers_question, '')), q) AS score
             FROM memory m, plainto_tsquery('english', $1) q
             WHERE to_tsvector('english', coalesce(m.answers_question, '')) @@ q
             ORDER BY score DESC
             LIMIT 20`,
            [queryText],
        );

        if (!rows || rows.length === 0) return entries;

        const existingMap = new Map(entries.map((e) => [e.id, e]));
        const newIds: string[] = [];
        const topScore = rows[0].score || 1;

        // Boost existing entries found via question search
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

        // Fetch domain attributes for new entries
        const attrMap = new Map<string, Record<string, Record<string, unknown>>>();
        const normalizedIds = newIds.map((id) => (id.startsWith("memory:") ? id : `memory:${id}`));
        const ownershipEdges = await context.graph.query<{
            in_id: string;
            out_id: string;
            attributes: Record<string, unknown>;
        }>("SELECT in_id, out_id, attributes FROM owned_by WHERE in_id = ANY($1::text[])", [
            normalizedIds,
        ]);
        if (ownershipEdges) {
            for (const edge of ownershipEdges) {
                const memId = edge.in_id;
                const ownerDomain = edge.out_id.replace(/^domain:/, "");
                if (!attrMap.has(memId)) attrMap.set(memId, {});
                attrMap.get(memId)![ownerDomain] = edge.attributes ?? {};
            }
        }

        const newEntries: ScoredMemory[] = [];
        for (const row of rows) {
            const id = String(row.id);
            if (existingMap.has(id)) continue;

            const domainAttributes = attrMap.get(id) ?? {};
            if (!isEntryValid(getKbAttrs(domainAttributes, domainId), now)) continue;

            // Low base score — question-search entries fill remaining budget
            // rather than displacing hybrid search results
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

/**
 * MMR (Maximal Marginal Relevance) budget filling.
 * Selects entries that maximize: lambda * relevance - (1-lambda) * max_similarity_to_selected.
 * When lambda=1.0, behaves like pure greedy (relevance only).
 */
async function mmrBudgetFill(
    candidates: ScoredMemory[],
    budgetTokens: number,
    lambda: number,
    graph: GraphApi,
    domainId: string = KB_DOMAIN_ID,
): Promise<Array<{ mem: ScoredMemory; classification: string }>> {
    if (candidates.length === 0) return [];

    // When lambda=1.0, skip embedding fetch — pure relevance, same as old greedy
    if (lambda >= 1.0) {
        const sorted = [...candidates].sort((a, b) => b.score - a.score);
        const result: Array<{ mem: ScoredMemory; classification: string }> = [];
        let usedTokens = 0;
        for (const entry of sorted) {
            const tokens = countTokens(entry.content);
            if (usedTokens + tokens > budgetTokens) continue;
            usedTokens += tokens;
            const attrs = getKbAttrs(entry.domainAttributes, domainId);
            const cls = (attrs?.classification as string) ?? "fact";
            result.push({ mem: entry, classification: cls });
        }
        return result;
    }

    // Fetch embeddings for diversity computation
    const embeddingMap = await fetchEmbeddings(
        candidates.map((c) => c.id),
        graph,
    );
    const embeddingMapF32 = new Map<string, Float32Array>();
    for (const [id, emb] of embeddingMap) {
        embeddingMapF32.set(id, Float32Array.from(emb));
    }

    const remaining = candidates.map((c, i) => ({ entry: c, idx: i }));
    const selected: Array<{ mem: ScoredMemory; classification: string }> = [];
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

        const attrs = getKbAttrs(entry.domainAttributes, domainId);
        const cls = (attrs?.classification as string) ?? "fact";
        selected.push({ mem: entry, classification: cls });

        const emb = embeddingMapF32.get(entry.id);
        if (emb) selectedEmbeddings.push(emb);

        remaining.splice(bestIdx, 1);
    }

    return selected;
}

async function fetchEmbeddings(ids: string[], graph: GraphApi): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    if (ids.length === 0) return map;

    const normalizedIds = ids.map((id) => (id.startsWith("memory:") ? id : `memory:${id}`));

    try {
        const rows = await graph.query<{ id: string; embedding: number[] }>(
            `SELECT id, embedding FROM memory WHERE id = ANY($1::text[])`,
            [normalizedIds],
        );

        if (rows) {
            for (const row of rows) {
                if (row.embedding) {
                    map.set(row.id, row.embedding);
                }
            }
        }
    } catch {
        // If embedding fetch fails, MMR degrades to greedy (no diversity penalty)
    }

    return map;
}

const kbRegistration = createKbDomain();
export const kbDomain = kbRegistration.domain;
