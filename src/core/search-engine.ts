import { StringRecordId } from "surrealdb";
import type { GraphApi, EngineConfig, EmbeddingAdapter } from "./types.js";
import type { SearchQuery, SearchResult, ScoredMemory } from "./types.js";
import { countTokens, mergeScores, applyTokenBudget } from "./scoring.js";

interface MemoryRow {
    id: unknown;
    content: string;
    token_count: number;
    event_time: number | null;
    created_at: number;
    score?: number;
}

class SearchEngine {
    private defaultMode: NonNullable<SearchQuery["mode"]>;
    private defaultWeights: { vector: number; fulltext: number; graph: number };

    constructor(
        private store: GraphApi,
        searchConfig?: EngineConfig["search"],
        private embeddingAdapter?: EmbeddingAdapter,
    ) {
        this.defaultMode = searchConfig?.defaultMode ?? "hybrid";
        this.defaultWeights = {
            vector: searchConfig?.defaultWeights?.vector ?? 0.5,
            fulltext: searchConfig?.defaultWeights?.fulltext ?? 0.3,
            graph: searchConfig?.defaultWeights?.graph ?? 0.2,
        };
        if (!embeddingAdapter) {
            this.defaultWeights.vector = 0;
        }
    }

    async search(query: SearchQuery): Promise<SearchResult> {
        const mode = query.mode ?? this.defaultMode;
        const weights = {
            vector: query.weights?.vector ?? this.defaultWeights.vector,
            fulltext: query.weights?.fulltext ?? this.defaultWeights.fulltext,
            graph: query.weights?.graph ?? this.defaultWeights.graph,
        };
        const limit = query.limit ?? 10;

        let candidates: Map<string, ScoredMemory>;

        switch (mode) {
            case "vector":
                candidates = await this.vectorSearch(query);
                break;
            case "fulltext":
                candidates = await this.fulltextSearch(query);
                break;
            case "graph":
                candidates = await this.graphSearch(query);
                break;
            case "hybrid":
                candidates = await this.hybridSearch(query, weights);
                break;
            default:
                candidates = new Map();
        }

        // Apply ID filter
        if (query.ids && query.ids.length > 0) {
            const idSet = new Set(
                query.ids.map((id) => (id.startsWith("memory:") ? id : `memory:${id}`)),
            );
            const filtered = new Map<string, ScoredMemory>();
            for (const [id, mem] of candidates) {
                if (idSet.has(id)) {
                    filtered.set(id, mem);
                }
            }
            candidates = filtered;
        }

        // Apply tag filter (universal, across all search modes)
        if (query.tags && query.tags.length > 0) {
            candidates = await this.filterByTags(candidates, query.tags);
        }

        // Apply domain ownership filter
        if (query.domains && query.domains.length > 0) {
            candidates = await this.filterByDomainOwnership(candidates, query.domains);
        }

        // Compute final merged scores
        let entries = Array.from(candidates.values()).map((mem) => ({
            ...mem,
            score: mergeScores(mem.scores, weights),
        }));

        // Apply min score filter
        if (query.minScore !== undefined) {
            entries = entries.filter((e) => e.score >= (query.minScore ?? 0));
        }

        // Sort by score descending
        entries.sort((a, b) => b.score - a.score);

        // Apply limit
        entries = entries.slice(0, limit);

        // Apply token budget
        if (query.tokenBudget) {
            const budgeted = applyTokenBudget(
                entries.map((e) => ({ ...e, tokenCount: this.getTokenCount(e) })),
                query.tokenBudget,
            );
            entries = budgeted;
        }

        // Enrich results with connections and domain attributes
        await Promise.all([this.enrichConnections(entries), this.enrichDomainAttributes(entries)]);

        const totalTokens = entries.reduce((sum, e) => sum + this.getTokenCount(e), 0);

        return {
            entries,
            totalTokens,
            mode,
            stats: {
                mergedTotal: candidates.size,
            },
        };
    }

    private getTokenCount(mem: ScoredMemory): number {
        if (mem.tokenCount !== undefined) return mem.tokenCount;
        return countTokens(mem.content);
    }

    private async vectorSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        const candidates = new Map<string, ScoredMemory>();
        if (!this.embeddingAdapter || !query.text) return candidates;

        const queryVec = await this.embeddingAdapter.embed(query.text);

        const rows = await this.store.query<(MemoryRow & { score: number })[]>(
            `SELECT *, vector::similarity::cosine(embedding, $queryVec) AS score
       FROM memory
       WHERE embedding IS NOT NONE
       ORDER BY score DESC
       LIMIT $limit`,
            { queryVec, limit: query.limit ?? 10 },
        );

        if (!rows) return candidates;

        for (const row of rows) {
            const id = String(row.id);
            const tags = await this.getMemoryTags(id);
            candidates.set(id, {
                id,
                content: row.content,
                score: row.score,
                scores: { vector: row.score },
                tags,
                domainAttributes: {},
                eventTime: row.event_time ?? null,
                createdAt: row.created_at,
                tokenCount: row.token_count,
            });
        }

        return candidates;
    }

    private async fulltextSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        const candidates = new Map<string, ScoredMemory>();
        if (!query.text) return candidates;

        // Try BM25 full-text search first
        let rows: MemoryRow[] = [];
        try {
            rows = await this.store.query<MemoryRow[]>(
                `SELECT *, search::score(1) AS score FROM memory
         WHERE content @1@ $text
         ORDER BY score DESC
         LIMIT $limit`,
                { text: query.text, limit: query.limit ?? 10 },
            );
        } catch {
            // BM25 index may not be defined; fall back to CONTAINS
        }

        // Fallback to CONTAINS if BM25 returned nothing
        if (!rows || rows.length === 0) {
            rows = await this.containsFallback(query.text, query.limit ?? 10);
        }

        for (const row of rows) {
            const id = String(row.id);
            const tags = await this.getMemoryTags(id);
            candidates.set(id, {
                id,
                content: row.content,
                score: row.score ?? 0.5,
                scores: { fulltext: row.score ?? 0.5 },
                tags,
                domainAttributes: {},
                eventTime: row.event_time ?? null,
                createdAt: row.created_at,
                tokenCount: row.token_count,
            });
        }

        return candidates;
    }

    private async containsFallback(text: string, limit: number): Promise<MemoryRow[]> {
        // Split into keywords and search for each
        const keywords = text.split(/\s+/).filter((k) => k.length > 2);
        if (keywords.length === 0) return [];

        // Build OR conditions for each keyword
        const conditions = keywords.map(
            (_, i) => `string::lowercase(content) CONTAINS string::lowercase($kw${i})`,
        );
        const vars: Record<string, unknown> = { limit };
        keywords.forEach((kw, i) => {
            vars[`kw${i}`] = kw;
        });

        const surql = `SELECT * FROM memory WHERE ${conditions.join(" OR ")} LIMIT $limit`;
        const rows = await this.store.query<MemoryRow[]>(surql, vars);
        return rows ?? [];
    }

    private async graphSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        const candidates = new Map<string, ScoredMemory>();
        // Traversal-based search
        if (query.traversal) {
            const fromIds = Array.isArray(query.traversal.from)
                ? query.traversal.from
                : [query.traversal.from];

            for (const fromId of fromIds) {
                const results = await this.store.traverse<MemoryRow>(
                    String(fromId),
                    query.traversal.pattern,
                );
                for (const row of results) {
                    // Traversal patterns ending in .* return full rows; bare patterns return RecordIds.
                    // Detect which format we got by checking for the content property.
                    if (row.content === undefined) continue;
                    const id = String(row.id);
                    const tags = await this.getMemoryTags(id);
                    candidates.set(id, {
                        id,
                        content: row.content,
                        score: 1.0,
                        scores: { graph: 1.0 },
                        tags,
                        domainAttributes: {},
                        eventTime: row.event_time ?? null,
                        createdAt: row.created_at,
                        tokenCount: row.token_count,
                    });
                }
            }
            return candidates;
        }

        // Tag-based search
        if (query.tags && query.tags.length > 0) {
            const tagRefs = query.tags.map((t) => (t.startsWith("tag:") ? t : `tag:${t}`));
            const tagRecordIds = tagRefs.map((t) => new StringRecordId(t));

            const rows = await this.store.query<MemoryRow[]>(
                `SELECT * FROM memory WHERE ->tagged.out CONTAINSANY $tags LIMIT $limit`,
                { tags: tagRecordIds, limit: query.limit ?? 10 },
            );

            if (rows) {
                for (const row of rows) {
                    const id = String(row.id);
                    const tags = await this.getMemoryTags(id);
                    candidates.set(id, {
                        id,
                        content: row.content,
                        score: 1.0,
                        scores: { graph: 1.0 },
                        tags,
                        domainAttributes: {},
                        eventTime: row.event_time ?? null,
                        createdAt: row.created_at,
                        tokenCount: row.token_count,
                    });
                }
            }

            return candidates;
        }

        return candidates;
    }

    private async hybridSearch(
        query: SearchQuery,
        weights: { vector: number; fulltext: number; graph: number },
    ): Promise<Map<string, ScoredMemory>> {
        const [vectorCandidates, fulltextCandidates, graphCandidates] = await Promise.all([
            weights.vector > 0
                ? this.vectorSearch(query)
                : Promise.resolve(new Map<string, ScoredMemory>()),
            weights.fulltext > 0 && query.text
                ? this.fulltextSearch(query)
                : Promise.resolve(new Map<string, ScoredMemory>()),
            weights.graph > 0
                ? this.graphSearch(query)
                : Promise.resolve(new Map<string, ScoredMemory>()),
        ]);

        return this.mergeCandidates(vectorCandidates, fulltextCandidates, graphCandidates);
    }

    private mergeCandidates(
        ...candidateMaps: Map<string, ScoredMemory>[]
    ): Map<string, ScoredMemory> {
        const merged = new Map<string, ScoredMemory>();

        for (const candidates of candidateMaps) {
            for (const [id, mem] of candidates) {
                const existing = merged.get(id);
                if (existing) {
                    // Merge scores from different modes
                    existing.scores = {
                        vector: existing.scores.vector ?? mem.scores.vector,
                        fulltext: existing.scores.fulltext ?? mem.scores.fulltext,
                        graph: existing.scores.graph ?? mem.scores.graph,
                    };
                } else {
                    merged.set(id, { ...mem });
                }
            }
        }

        return merged;
    }

    private async filterByTags(
        candidates: Map<string, ScoredMemory>,
        requiredTags: string[],
    ): Promise<Map<string, ScoredMemory>> {
        const filtered = new Map<string, ScoredMemory>();
        if (candidates.size === 0) return filtered;

        const tagRefs = requiredTags.map(
            (t) => new StringRecordId(t.startsWith("tag:") ? t : `tag:${t}`),
        );
        const memIds = [...candidates.keys()].map((id) => new StringRecordId(id));

        const taggedRows = await this.store.query<{ in: unknown }[]>(
            "SELECT in FROM tagged WHERE in IN $memIds AND out IN $tagRefs",
            { memIds, tagRefs },
        );
        if (!taggedRows) return filtered;

        const taggedIds = new Set(taggedRows.map((r) => String(r.in)));

        for (const [id, mem] of candidates) {
            if (taggedIds.has(id)) {
                filtered.set(id, mem);
            }
        }

        return filtered;
    }

    private async filterByDomainOwnership(
        candidates: Map<string, ScoredMemory>,
        domainIds: string[],
    ): Promise<Map<string, ScoredMemory>> {
        const filtered = new Map<string, ScoredMemory>();
        const domainRefs = domainIds.map((d) => (d.startsWith("domain:") ? d : `domain:${d}`));

        // Query all owned_by edges for the given domains
        const ownedEdges = await this.store.query<{ in: unknown; out: unknown }[]>(
            `SELECT in, out FROM owned_by WHERE out IN $domainRefs`,
            { domainRefs: domainRefs.map((d) => new StringRecordId(d)) },
        );

        if (!ownedEdges) return filtered;

        const ownedMemoryIds = new Set(ownedEdges.map((e) => String(e.in)));

        for (const [id, mem] of candidates) {
            if (ownedMemoryIds.has(id)) {
                filtered.set(id, mem);
            }
        }

        return filtered;
    }

    private async enrichConnections(entries: ScoredMemory[]): Promise<void> {
        if (entries.length === 0) return;
        const ids = entries.map((e) => new StringRecordId(e.id));

        const edges: { id: unknown; in: unknown; out: unknown }[] = [];
        for (const table of ["reinforces", "contradicts", "summarizes", "refines"]) {
            const rows = await this.store.query<{ id: unknown; in: unknown; out: unknown }[]>(
                `SELECT id, in, out FROM ${table} WHERE in IN $ids OR out IN $ids`,
                { ids },
            );
            if (rows) edges.push(...rows);
        }

        if (edges.length === 0) return;

        const connectionMap = new Map<string, { id: string; type: string }[]>();

        for (const edge of edges) {
            const edgeIdStr = String(edge.id);
            const edgeType = edgeIdStr.includes(":") ? edgeIdStr.split(":")[0] : "unknown";
            const inId = String(edge.in);
            const outId = String(edge.out);

            if (!connectionMap.has(inId)) connectionMap.set(inId, []);
            connectionMap.get(inId)!.push({ id: outId, type: edgeType });

            if (!connectionMap.has(outId)) connectionMap.set(outId, []);
            connectionMap.get(outId)!.push({ id: inId, type: edgeType });
        }

        for (const entry of entries) {
            const refs = connectionMap.get(entry.id);
            if (refs && refs.length > 0) {
                entry.connections = { references: refs };
            }
        }
    }

    private async enrichDomainAttributes(entries: ScoredMemory[]): Promise<void> {
        if (entries.length === 0) return;
        const ids = entries.map((e) => new StringRecordId(e.id));

        const ownershipEdges = await this.store.query<
            {
                in: unknown;
                out: unknown;
                attributes: Record<string, unknown>;
            }[]
        >("SELECT in, out, attributes FROM owned_by WHERE in IN $ids", { ids });
        if (!ownershipEdges) return;

        const attrMap = new Map<string, Record<string, Record<string, unknown>>>();
        for (const edge of ownershipEdges) {
            const memId = String(edge.in);
            const domainId = String(edge.out).replace("domain:", "");
            if (!attrMap.has(memId)) attrMap.set(memId, {});
            attrMap.get(memId)![domainId] = edge.attributes ?? {};
        }

        for (const entry of entries) {
            entry.domainAttributes = attrMap.get(entry.id) ?? {};
        }
    }

    private async getMemoryTags(memoryId: string): Promise<string[]> {
        const tags = await this.store.query<string[]>(
            `SELECT VALUE out.label FROM tagged WHERE in = $mem`,
            { mem: new StringRecordId(memoryId) },
        );
        if (!tags || !Array.isArray(tags)) return [];
        return tags.filter((label): label is string => typeof label === "string");
    }
}

export { SearchEngine };
