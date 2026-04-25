import type { GraphApi, EngineConfig, EmbeddingAdapter, DebugTools } from "./types.js";
import type { SearchQuery, SearchResult, ScoredMemory } from "./types.js";
import { countTokens, mergeScores, applyTokenBudget, cosineSimilarityF32 } from "./scoring.js";
import { createDebugTools } from "./debug.js";

const NOOP_DEBUG: DebugTools = createDebugTools("search", { timing: false });

interface MemoryRow {
    id: string;
    content: string;
    token_count: number;
    event_time: number | null;
    created_at: number;
    score?: number;
}

interface FilterClause {
    sql: string[];
    values: unknown[];
}

/**
 * Parse the legacy traversal-pattern string into a structured form. We accept
 * the two shapes used by bundled framework domains and topic-linking:
 *
 *   `->{edge}->{table}`  — starting nodes are the `in` of the edge; result is
 *                          the connected `{table}` row (`out`).
 *   `<-{edge}<-{table}`  — starting nodes are the `out` of the edge; result is
 *                          the connected `{table}` row (`in`).
 *
 * A trailing `.*` is allowed and ignored — it used to mean "fetch full row"
 * versus "fetch id only" in SurrealQL; under PG we always select the row.
 */
function parseTraversalPattern(
    pattern: string,
): { direction: "out" | "in"; edge: string; table: string } | null {
    const cleaned = pattern.replace(/\.\*$/, "");
    let m = cleaned.match(/^->([a-z_][a-z0-9_]*)->([a-z_][a-z0-9_]*)$/i);
    if (m) return { direction: "out", edge: m[1], table: m[2] };
    m = cleaned.match(/^<-([a-z_][a-z0-9_]*)<-([a-z_][a-z0-9_]*)$/i);
    if (m) return { direction: "in", edge: m[1], table: m[2] };
    return null;
}

function buildFilterClauses(
    filters: Record<string, unknown> | undefined,
    beforeTime: number | undefined,
    afterTime: number | undefined,
    paramOffset: number,
): FilterClause {
    const sql: string[] = [];
    const values: unknown[] = [];
    let i = paramOffset;

    if (beforeTime !== undefined) {
        sql.push(`event_time <= $${i}`);
        values.push(beforeTime);
        i++;
    }
    if (afterTime !== undefined) {
        sql.push(`event_time >= $${i}`);
        values.push(afterTime);
        i++;
    }

    if (filters) {
        for (const [field, value] of Object.entries(filters)) {
            if (value === undefined) continue;
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const obj = value as Record<string, unknown>;
                if ("containsAny" in obj && Array.isArray(obj.containsAny)) {
                    sql.push(`${field}::jsonb ?| $${i}::text[]`);
                    values.push(obj.containsAny.map(String));
                    i++;
                }
                continue;
            }
            if (Array.isArray(value)) {
                sql.push(`${field} = ANY($${i}::text[])`);
                values.push(value.map(String));
                i++;
            } else {
                sql.push(`${field} = $${i}`);
                values.push(value);
                i++;
            }
        }
    }
    return { sql, values };
}

function vectorLiteral(vec: number[] | Float32Array): string {
    // pgvector accepts the textual `[v1,v2,...]` form. Fast path that avoids
    // JSON.stringify quote handling.
    let s = "[";
    for (let i = 0; i < vec.length; i++) {
        if (i > 0) s += ",";
        s += vec[i];
    }
    return s + "]";
}

function ensurePrefix(id: string, prefix: string): string {
    return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

class SearchEngine {
    private defaultMode: NonNullable<SearchQuery["mode"]>;
    private defaultWeights: { vector: number; fulltext: number; graph: number };
    private debug: DebugTools;

    constructor(
        private store: GraphApi,
        searchConfig?: EngineConfig["search"],
        private embeddingAdapter?: EmbeddingAdapter,
        debug?: DebugTools,
    ) {
        this.debug = debug ?? NOOP_DEBUG;
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

    search(query: SearchQuery): Promise<SearchResult> {
        return this.debug.time("search.total", () => this.searchImpl(query), {
            mode: query.mode ?? this.defaultMode,
            hasText: query.text ? 1 : 0,
            tags: query.tags?.length ?? 0,
            skipConnections: query.skipConnections ? 1 : 0,
            skipPluginExpansion: query.skipPluginExpansion ? 1 : 0,
        });
    }

    private async searchImpl(query: SearchQuery): Promise<SearchResult> {
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

        if (query.ids && query.ids.length > 0) {
            const idSet = new Set(query.ids.map((id) => ensurePrefix(id, "memory:")));
            const filtered = new Map<string, ScoredMemory>();
            for (const [id, mem] of candidates) {
                if (idSet.has(id)) filtered.set(id, mem);
            }
            candidates = filtered;
        }

        if (query.tags && query.tags.length > 0) {
            candidates = await this.filterByTags(candidates, query.tags);
        }
        if (query.domains && query.domains.length > 0) {
            candidates = await this.filterByDomainOwnership(candidates, query.domains);
        }

        const mergeOptions = { penalizeMissing: mode === "hybrid" };
        let entries = Array.from(candidates.values()).map((mem) => ({
            ...mem,
            score: mergeScores(mem.scores, weights, mergeOptions),
        }));

        if (query.minScore !== undefined) {
            entries = entries.filter((e) => e.score >= (query.minScore ?? 0));
        }
        entries.sort((a, b) => b.score - a.score);

        if (query.rerank && query.text) {
            entries = await this.rerankByEmbedding(
                entries,
                query.text,
                query.rerankThreshold ?? 0.5,
            );
        }
        entries = entries.slice(0, limit);

        if (query.tokenBudget) {
            entries = applyTokenBudget(
                entries.map((e) => ({ ...e, tokenCount: this.getTokenCount(e) })),
                query.tokenBudget,
            );
        }

        await Promise.all([
            query.skipConnections ? Promise.resolve() : this.enrichConnections(entries),
            this.enrichDomainAttributes(entries),
        ]);

        const totalTokens = entries.reduce((sum, e) => sum + this.getTokenCount(e), 0);
        return {
            entries,
            totalTokens,
            mode,
            stats: { mergedTotal: candidates.size },
        };
    }

    private getTokenCount(mem: ScoredMemory): number {
        if (mem.tokenCount !== undefined) return mem.tokenCount;
        return countTokens(mem.content);
    }

    // ----- Mode implementations -----

    private vectorSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        return this.debug.time("vectorSearch", () => this.vectorSearchImpl(query), {
            hasText: query.text ? 1 : 0,
            limit: query.limit ?? 10,
        });
    }

    private async vectorSearchImpl(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        const candidates = new Map<string, ScoredMemory>();
        if (!this.embeddingAdapter || !query.text) return candidates;

        const queryVec = await this.embeddingAdapter.embed(query.text);
        const vec = vectorLiteral(queryVec);
        const limit = query.limit ?? 10;

        // $1 = vector literal, $2 = limit, then any filter params.
        const filter = buildFilterClauses(
            query.filters,
            query.beforeTime,
            query.afterTime,
            3,
        );
        const filterSql = filter.sql.length > 0 ? ` AND ${filter.sql.join(" AND ")}` : "";

        // 1 - cosine_distance gives us a similarity in [0, 2] inverted; for
        // normalized vectors this is in [0, 1] with 1 = identical. Ordering
        // by `embedding <=> $1::vector` ascending uses the HNSW index.
        const sql = `
            SELECT id, content, token_count, event_time, created_at,
                   1 - (embedding <=> $1::vector) AS score
            FROM memory
            WHERE embedding IS NOT NULL${filterSql}
            ORDER BY embedding <=> $1::vector ASC
            LIMIT $2`;
        const rows = await this.store.query<MemoryRow & { score: number }>(sql, [
            vec,
            limit,
            ...filter.values,
        ]);

        for (const row of rows) {
            const id = String(row.id);
            candidates.set(id, {
                id,
                content: row.content,
                score: row.score,
                scores: { vector: row.score },
                tags: [],
                domainAttributes: {},
                eventTime: row.event_time ?? null,
                createdAt: row.created_at,
                tokenCount: row.token_count,
            });
        }

        await this.hydrateTags(candidates);
        return candidates;
    }

    private fulltextSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        return this.debug.time("fulltextSearch", () => this.fulltextSearchImpl(query), {
            hasText: query.text ? 1 : 0,
            limit: query.limit ?? 10,
        });
    }

    private async fulltextSearchImpl(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        const candidates = new Map<string, ScoredMemory>();
        if (!query.text) return candidates;

        const limit = query.limit ?? 10;
        const filter = buildFilterClauses(
            query.filters,
            query.beforeTime,
            query.afterTime,
            3,
        );
        const filterSql = filter.sql.length > 0 ? ` AND ${filter.sql.join(" AND ")}` : "";

        const tsq = `plainto_tsquery('english', $1)`;
        let rows = await this.store.query<MemoryRow>(
            `SELECT id, content, token_count, event_time, created_at,
                    ts_rank(to_tsvector('english', content), ${tsq}) AS score
             FROM memory
             WHERE to_tsvector('english', content) @@ ${tsq}${filterSql}
             ORDER BY score DESC
             LIMIT $2`,
            [query.text, limit, ...filter.values],
        );

        if (rows.length === 0) {
            rows = await this.containsFallback(
                query.text,
                limit,
                query.filters,
                query.beforeTime,
                query.afterTime,
            );
        }

        for (const row of rows) {
            const id = String(row.id);
            candidates.set(id, {
                id,
                content: row.content,
                score: row.score ?? 0.5,
                scores: { fulltext: row.score ?? 0.5 },
                tags: [],
                domainAttributes: {},
                eventTime: row.event_time ?? null,
                createdAt: row.created_at,
                tokenCount: row.token_count,
            });
        }

        await this.hydrateTags(candidates);
        return candidates;
    }

    private async containsFallback(
        text: string,
        limit: number,
        filters: Record<string, unknown> | undefined,
        beforeTime: number | undefined,
        afterTime: number | undefined,
    ): Promise<MemoryRow[]> {
        const keywords = text.split(/\s+/).filter((k) => k.length > 2);
        if (keywords.length === 0) return [];

        const values: unknown[] = [];
        const ilikeClauses = keywords.map((kw, idx) => {
            values.push(`%${kw}%`);
            return `content ILIKE $${idx + 1}`;
        });

        const filter = buildFilterClauses(filters, beforeTime, afterTime, values.length + 1);
        values.push(...filter.values);
        const filterSql = filter.sql.length > 0 ? ` AND ${filter.sql.join(" AND ")}` : "";

        values.push(limit);
        const sql = `SELECT id, content, token_count, event_time, created_at, 0.3 AS score
                     FROM memory
                     WHERE (${ilikeClauses.join(" OR ")})${filterSql}
                     LIMIT $${values.length}`;
        return this.store.query<MemoryRow>(sql, values);
    }

    private graphSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        return this.debug.time("graphSearch", () => this.graphSearchImpl(query), {
            tags: query.tags?.length ?? 0,
            traversal: query.traversal ? 1 : 0,
            limit: query.limit ?? 10,
        });
    }

    private async graphSearchImpl(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
        const candidates = new Map<string, ScoredMemory>();
        const limit = query.limit ?? 10;

        if (query.traversal) {
            const fromIds = Array.isArray(query.traversal.from)
                ? query.traversal.from
                : [query.traversal.from];

            const parsed = parseTraversalPattern(query.traversal.pattern);
            if (!parsed) {
                throw new Error(
                    `Unsupported traversal pattern under Postgres backend: "${query.traversal.pattern}". ` +
                        `Supported: '->edge->table' or '<-edge<-table' (with optional trailing '.*').`,
                );
            }

            // For "out" direction: match WHERE in_id = ANY(fromIds) and join target table on out_id.
            // For "in" direction: match WHERE out_id = ANY(fromIds) and join target table on in_id.
            const joinFromCol = parsed.direction === "out" ? "out_id" : "in_id";
            const matchCol = parsed.direction === "out" ? "in_id" : "out_id";

            const rows = await this.store.query<MemoryRow>(
                `SELECT t.id, t.content, t.token_count, t.event_time, t.created_at
                 FROM ${parsed.table} t
                 JOIN ${parsed.edge} e ON e.${joinFromCol} = t.id
                 WHERE e.${matchCol} = ANY($1::text[])`,
                [fromIds],
            );
            for (const row of rows) {
                if (row.content === undefined) continue;
                const id = String(row.id);
                candidates.set(id, {
                    id,
                    content: row.content,
                    score: 1.0,
                    scores: { graph: 1.0 },
                    tags: [],
                    domainAttributes: {},
                    eventTime: row.event_time ?? null,
                    createdAt: row.created_at,
                    tokenCount: row.token_count,
                });
            }

            await this.hydrateTags(candidates);
            return candidates;
        }

        if (query.tags && query.tags.length > 0) {
            const tagIds = query.tags.map((t) => ensurePrefix(t, "tag:"));
            const rows = await this.store.query<MemoryRow>(
                `SELECT m.id, m.content, m.token_count, m.event_time, m.created_at
                 FROM memory m
                 JOIN tagged tg ON tg.in_id = m.id
                 WHERE tg.out_id = ANY($1::text[])
                 LIMIT $2`,
                [tagIds, limit],
            );
            for (const row of rows) {
                const id = String(row.id);
                candidates.set(id, {
                    id,
                    content: row.content,
                    score: 1.0,
                    scores: { graph: 1.0 },
                    tags: [],
                    domainAttributes: {},
                    eventTime: row.event_time ?? null,
                    createdAt: row.created_at,
                    tokenCount: row.token_count,
                });
            }
            await this.hydrateTags(candidates);
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

    // ----- Filters -----

    private async filterByTags(
        candidates: Map<string, ScoredMemory>,
        requiredTags: string[],
    ): Promise<Map<string, ScoredMemory>> {
        const filtered = new Map<string, ScoredMemory>();
        if (candidates.size === 0) return filtered;

        const tagIds = requiredTags.map((t) => ensurePrefix(t, "tag:"));
        const memIds = [...candidates.keys()];
        const rows = await this.store.query<{ in_id: string }>(
            `SELECT DISTINCT in_id FROM tagged
             WHERE in_id = ANY($1::text[]) AND out_id = ANY($2::text[])`,
            [memIds, tagIds],
        );
        const tagged = new Set(rows.map((r) => r.in_id));
        for (const [id, mem] of candidates) {
            if (tagged.has(id)) filtered.set(id, mem);
        }
        return filtered;
    }

    private async filterByDomainOwnership(
        candidates: Map<string, ScoredMemory>,
        domainIds: string[],
    ): Promise<Map<string, ScoredMemory>> {
        const filtered = new Map<string, ScoredMemory>();
        const domains = domainIds.map((d) => ensurePrefix(d, "domain:"));
        const rows = await this.store.query<{ in_id: string }>(
            `SELECT DISTINCT in_id FROM owned_by WHERE out_id = ANY($1::text[])`,
            [domains],
        );
        const owned = new Set(rows.map((r) => r.in_id));
        for (const [id, mem] of candidates) {
            if (owned.has(id)) filtered.set(id, mem);
        }
        return filtered;
    }

    // ----- Enrichment -----

    private enrichConnections(entries: ScoredMemory[]): Promise<void> {
        return this.debug.time("enrichConnections", () => this.enrichConnectionsImpl(entries), {
            entries: entries.length,
        });
    }

    private async enrichConnectionsImpl(entries: ScoredMemory[]): Promise<void> {
        if (entries.length === 0) return;
        const ids = entries.map((e) => e.id);
        const refTables = ["reinforces", "contradicts", "summarizes", "refines"];

        const allEdges: { id: string; in_id: string; out_id: string; edge: string }[] = [];
        for (const tbl of refTables) {
            const rows = await this.store.query<{ id: string; in_id: string; out_id: string }>(
                `SELECT id, in_id, out_id FROM ${tbl}
                 WHERE in_id = ANY($1::text[]) OR out_id = ANY($1::text[])`,
                [ids],
            );
            for (const r of rows) allEdges.push({ ...r, edge: tbl });
        }
        if (allEdges.length === 0) return;

        const connectionMap = new Map<string, { id: string; type: string }[]>();
        for (const e of allEdges) {
            if (!connectionMap.has(e.in_id)) connectionMap.set(e.in_id, []);
            connectionMap.get(e.in_id)!.push({ id: e.out_id, type: e.edge });
            if (!connectionMap.has(e.out_id)) connectionMap.set(e.out_id, []);
            connectionMap.get(e.out_id)!.push({ id: e.in_id, type: e.edge });
        }

        for (const entry of entries) {
            const refs = connectionMap.get(entry.id);
            if (refs && refs.length > 0) {
                entry.connections = { references: refs };
            }
        }
    }

    private enrichDomainAttributes(entries: ScoredMemory[]): Promise<void> {
        return this.debug.time(
            "enrichDomainAttributes",
            () => this.enrichDomainAttributesImpl(entries),
            { entries: entries.length },
        );
    }

    private async enrichDomainAttributesImpl(entries: ScoredMemory[]): Promise<void> {
        if (entries.length === 0) return;
        const ids = entries.map((e) => e.id);

        // owned_by uses `attributes` jsonb column when domains store per-memory metadata.
        // The column may not exist if no domain has registered it yet — guard with try/catch.
        let rows: Array<{ in_id: string; out_id: string; attributes: unknown }> = [];
        try {
            rows = await this.store.query<{
                in_id: string;
                out_id: string;
                attributes: unknown;
            }>(
                `SELECT in_id, out_id, attributes FROM owned_by WHERE in_id = ANY($1::text[])`,
                [ids],
            );
        } catch {
            rows = await this.store.query<{
                in_id: string;
                out_id: string;
                attributes: unknown;
            }>(`SELECT in_id, out_id, NULL AS attributes FROM owned_by WHERE in_id = ANY($1::text[])`, [
                ids,
            ]);
        }

        const attrMap = new Map<string, Record<string, Record<string, unknown>>>();
        for (const row of rows) {
            const memId = row.in_id;
            const domainId = row.out_id.replace(/^domain:/, "");
            if (!attrMap.has(memId)) attrMap.set(memId, {});
            const attrs =
                row.attributes && typeof row.attributes === "object"
                    ? (row.attributes as Record<string, unknown>)
                    : {};
            attrMap.get(memId)![domainId] = attrs;
        }

        for (const entry of entries) {
            entry.domainAttributes = attrMap.get(entry.id) ?? {};
        }
    }

    private hydrateTags(candidates: Map<string, ScoredMemory>): Promise<void> {
        return this.debug.time("hydrateTags", () => this.hydrateTagsImpl(candidates), {
            entries: candidates.size,
        });
    }

    private async hydrateTagsImpl(candidates: Map<string, ScoredMemory>): Promise<void> {
        if (candidates.size === 0) return;
        const ids = [...candidates.keys()];
        const rows = await this.store.query<{ in_id: string; label: string }>(
            `SELECT tg.in_id, tag.label
             FROM tagged tg
             JOIN tag ON tag.id = tg.out_id
             WHERE tg.in_id = ANY($1::text[])`,
            [ids],
        );
        const tagMap = new Map<string, string[]>();
        for (const r of rows) {
            const arr = tagMap.get(r.in_id);
            if (arr) arr.push(r.label);
            else tagMap.set(r.in_id, [r.label]);
        }
        for (const [id, mem] of candidates) {
            mem.tags = tagMap.get(id) ?? [];
        }
    }

    private async rerankByEmbedding(
        entries: ScoredMemory[],
        queryText: string,
        threshold: number,
    ): Promise<ScoredMemory[]> {
        if (!this.embeddingAdapter || entries.length === 0) return entries;

        const queryVec = await this.embeddingAdapter.embed(queryText);
        const ids = entries.map((e) => ensurePrefix(e.id, "memory:"));

        // pgvector returns vector columns as text in the form `[v1,v2,...]`.
        const rows = await this.store.query<{ id: string; embedding: string | null }>(
            `SELECT id, embedding::text AS embedding FROM memory WHERE id = ANY($1::text[])`,
            [ids],
        );

        const embeddingMap = new Map<string, Float32Array>();
        for (const row of rows) {
            if (!row.embedding) continue;
            const arr = JSON.parse(row.embedding) as number[];
            embeddingMap.set(row.id, Float32Array.from(arr));
        }

        const queryVecF32 = Float32Array.from(queryVec);
        const reranked: ScoredMemory[] = [];
        for (const entry of entries) {
            const emb = embeddingMap.get(entry.id);
            if (!emb) {
                reranked.push(entry);
                continue;
            }
            const similarity = cosineSimilarityF32(queryVecF32, emb);
            if (similarity >= threshold) {
                reranked.push({ ...entry, score: similarity });
            }
        }
        reranked.sort((a, b) => b.score - a.score);
        return reranked;
    }
}

export { SearchEngine };
