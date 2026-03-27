import { StringRecordId } from 'surrealdb'
import type { GraphApi } from './types.ts'
import type { SearchQuery, SearchResult, ScoredMemory } from './types.ts'
import { countTokens, mergeScores, applyTokenBudget } from './scoring.ts'

interface MemoryRow {
  id: unknown
  content: string
  token_count: number
  event_time: number | null
  created_at: number
  score?: number
}

const DEFAULT_WEIGHTS = { vector: 0.5, fulltext: 0.3, graph: 0.2 }

class SearchEngine {
  constructor(private store: GraphApi) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    const mode = query.mode ?? 'hybrid'
    const weights = {
      vector: query.weights?.vector ?? DEFAULT_WEIGHTS.vector,
      fulltext: query.weights?.fulltext ?? DEFAULT_WEIGHTS.fulltext,
      graph: query.weights?.graph ?? DEFAULT_WEIGHTS.graph,
    }
    const limit = query.limit ?? 20

    let candidates: Map<string, ScoredMemory>

    switch (mode) {
      case 'vector':
        candidates = await this.vectorSearch(query)
        break
      case 'fulltext':
        candidates = await this.fulltextSearch(query)
        break
      case 'graph':
        candidates = await this.graphSearch(query)
        break
      case 'hybrid':
        candidates = await this.hybridSearch(query, weights)
        break
      default:
        candidates = new Map()
    }

    // Apply domain ownership filter
    if (query.domains && query.domains.length > 0) {
      candidates = await this.filterByDomainOwnership(candidates, query.domains)
    }

    // Compute final merged scores
    let entries = Array.from(candidates.values()).map(mem => ({
      ...mem,
      score: mergeScores(mem.scores, weights),
    }))

    // Apply min score filter
    if (query.minScore !== undefined) {
      entries = entries.filter(e => e.score >= (query.minScore ?? 0))
    }

    // Sort by score descending
    entries.sort((a, b) => b.score - a.score)

    // Apply limit
    entries = entries.slice(0, limit)

    // Apply token budget
    let totalTokens = 0
    if (query.tokenBudget) {
      const budgeted = applyTokenBudget(
        entries.map(e => ({ ...e, tokenCount: this.getTokenCount(e) })),
        query.tokenBudget
      )
      entries = budgeted
    }

    totalTokens = entries.reduce((sum, e) => sum + this.getTokenCount(e), 0)

    return {
      entries,
      totalTokens,
      mode,
      stats: {
        mergedTotal: candidates.size,
      },
    }
  }

  private getTokenCount(mem: ScoredMemory): number {
    // tokenCount is stored in domainAttributes under __tokenCount or computed from content
    const stored = (mem as unknown as Record<string, unknown>).tokenCount
    if (typeof stored === 'number') return stored
    return countTokens(mem.content)
  }

  private async vectorSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
    // Vector search requires embeddings — fail gracefully if not available
    const candidates = new Map<string, ScoredMemory>()
    // KNN search would go here once embedding model is configured
    // For now, return empty results
    return candidates
  }

  private async fulltextSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
    const candidates = new Map<string, ScoredMemory>()
    if (!query.text) return candidates

    // Try BM25 full-text search first
    let rows: MemoryRow[] = []
    try {
      rows = await this.store.query<MemoryRow[]>(
        `SELECT *, search::score(1) AS score FROM memory
         WHERE content @1@ $text
         ORDER BY score DESC
         LIMIT $limit`,
        { text: query.text, limit: query.limit ?? 20 }
      )
    } catch {
      // BM25 index may not be defined; fall back to CONTAINS
    }

    // Fallback to CONTAINS if BM25 returned nothing
    if (!rows || rows.length === 0) {
      rows = await this.containsFallback(query.text, query.limit ?? 20)
    }

    for (const row of rows) {
      const id = String(row.id)
      const tags = await this.getMemoryTags(id)
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
      } as ScoredMemory & { tokenCount: number })
    }

    return candidates
  }

  private async containsFallback(text: string, limit: number): Promise<MemoryRow[]> {
    // Split into keywords and search for each
    const keywords = text.split(/\s+/).filter(k => k.length > 2)
    if (keywords.length === 0) return []

    // Build OR conditions for each keyword
    const conditions = keywords.map((_, i) => `string::lowercase(content) CONTAINS string::lowercase($kw${i})`)
    const vars: Record<string, unknown> = { limit }
    keywords.forEach((kw, i) => {
      vars[`kw${i}`] = kw
    })

    const surql = `SELECT * FROM memory WHERE ${conditions.join(' OR ')} LIMIT $limit`
    const rows = await this.store.query<MemoryRow[]>(surql, vars)
    return rows ?? []
  }

  private async graphSearch(query: SearchQuery): Promise<Map<string, ScoredMemory>> {
    const candidates = new Map<string, ScoredMemory>()

    // Traversal-based search
    if (query.traversal) {
      const fromIds = Array.isArray(query.traversal.from)
        ? query.traversal.from
        : [query.traversal.from]

      for (const fromId of fromIds) {
        const results = await this.store.traverse<MemoryRow>(
          fromId,
          query.traversal.pattern
        )
        for (const row of results) {
          const id = String(row.id)
          const tags = await this.getMemoryTags(id)
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
          } as ScoredMemory & { tokenCount: number })
        }
      }
      return candidates
    }

    // Tag-based search
    if (query.tags && query.tags.length > 0) {
      const tagRefs = query.tags.map(t => t.startsWith('tag:') ? t : `tag:${t}`)
      const tagRecordIds = tagRefs.map(t => new StringRecordId(t))

      const rows = await this.store.query<MemoryRow[]>(
        `SELECT * FROM memory WHERE ->tagged.out CONTAINSANY $tags LIMIT $limit`,
        { tags: tagRecordIds, limit: query.limit ?? 20 }
      )

      if (rows) {
        for (const row of rows) {
          const id = String(row.id)
          const tags = await this.getMemoryTags(id)
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
          } as ScoredMemory & { tokenCount: number })
        }
      }

      return candidates
    }

    // Recency fallback — return most recent memories
    const rows = await this.store.query<MemoryRow[]>(
      `SELECT * FROM memory ORDER BY created_at DESC LIMIT $limit`,
      { limit: query.limit ?? 20 }
    )

    if (rows) {
      for (const row of rows) {
        const id = String(row.id)
        const tags = await this.getMemoryTags(id)
        candidates.set(id, {
          id,
          content: row.content,
          score: 0.5,
          scores: { graph: 0.5 },
          tags,
          domainAttributes: {},
          eventTime: row.event_time ?? null,
          createdAt: row.created_at,
          tokenCount: row.token_count,
        } as ScoredMemory & { tokenCount: number })
      }
    }

    return candidates
  }

  private async hybridSearch(
    query: SearchQuery,
    weights: { vector: number; fulltext: number; graph: number }
  ): Promise<Map<string, ScoredMemory>> {
    const [vectorCandidates, fulltextCandidates, graphCandidates] = await Promise.all([
      weights.vector > 0 ? this.vectorSearch(query) : new Map<string, ScoredMemory>(),
      weights.fulltext > 0 && query.text ? this.fulltextSearch(query) : new Map<string, ScoredMemory>(),
      weights.graph > 0 ? this.graphSearch(query) : new Map<string, ScoredMemory>(),
    ])

    return this.mergeCandidates(vectorCandidates, fulltextCandidates, graphCandidates)
  }

  private mergeCandidates(
    ...candidateMaps: Map<string, ScoredMemory>[]
  ): Map<string, ScoredMemory> {
    const merged = new Map<string, ScoredMemory>()

    for (const candidates of candidateMaps) {
      for (const [id, mem] of candidates) {
        const existing = merged.get(id)
        if (existing) {
          // Merge scores from different modes
          existing.scores = {
            vector: existing.scores.vector ?? mem.scores.vector,
            fulltext: existing.scores.fulltext ?? mem.scores.fulltext,
            graph: existing.scores.graph ?? mem.scores.graph,
          }
        } else {
          merged.set(id, { ...mem })
        }
      }
    }

    return merged
  }

  private async filterByDomainOwnership(
    candidates: Map<string, ScoredMemory>,
    domainIds: string[]
  ): Promise<Map<string, ScoredMemory>> {
    const filtered = new Map<string, ScoredMemory>()
    const domainRefs = domainIds.map(d => d.startsWith('domain:') ? d : `domain:${d}`)

    // Query all owned_by edges for the given domains
    const ownedEdges = await this.store.query<{ in: unknown; out: unknown }[]>(
      `SELECT in, out FROM owned_by WHERE out IN $domainRefs`,
      { domainRefs: domainRefs.map(d => new StringRecordId(d)) }
    )

    if (!ownedEdges) return filtered

    const ownedMemoryIds = new Set(ownedEdges.map(e => String(e.in)))

    for (const [id, mem] of candidates) {
      if (ownedMemoryIds.has(id)) {
        filtered.set(id, mem)
      }
    }

    return filtered
  }

  private async getMemoryTags(memoryId: string): Promise<string[]> {
    const tags = await this.store.query<{ label: string }[]>(
      `SELECT VALUE out.label FROM tagged WHERE in = $mem`,
      { mem: new StringRecordId(memoryId) }
    )
    if (!tags || !Array.isArray(tags)) return []
    return tags.map((t) => t.label).filter((label): label is string => typeof label === 'string')
  }
}

export { SearchEngine }
