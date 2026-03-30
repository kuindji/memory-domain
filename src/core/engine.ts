import { Surreal, StringRecordId } from 'surrealdb'
import { createNodeEngines } from '@surrealdb/node'
import { GraphStore } from './graph-store.ts'
import { SchemaRegistry } from './schema-registry.ts'
import { SearchEngine } from './search-engine.ts'
import { InboxProcessor } from './inbox-processor.ts'
import { DomainRegistry } from './domain-registry.ts'
import { Scheduler } from './scheduler.ts'
import { EventEmitter } from './events.ts'
import { logDomain } from '../domains/log-domain.ts'
import { countTokens, applyTokenBudget } from './scoring.ts'
import type {
  EngineConfig,
  DomainConfig,
  DomainContext,
  IngestOptions,
  IngestResult,
  SearchQuery,
  SearchResult,
  MemoryEntry,
  LLMAdapter,
  EmbeddingAdapter,
  ContextOptions,
  ContextResult,
  AskOptions,
  AskResult,
  ScoredMemory,
  MemoryFilter,
  RepetitionConfig,
  WriteMemoryEntry,
  RequestContext,
  Edge,
} from './types.ts'

class MemoryEngine {
  private db: Surreal | null = null
  private graph!: GraphStore
  private schema!: SchemaRegistry
  private searchEngine!: SearchEngine
  private inboxProcessor!: InboxProcessor
  private domainRegistry = new DomainRegistry()
  private scheduler!: Scheduler
  private events = new EventEmitter()
  private llm!: LLMAdapter
  private embedding?: EmbeddingAdapter
  private repetitionConfig?: RepetitionConfig
  private defaultContext: RequestContext = {}

  async initialize(config: EngineConfig): Promise<void> {
    const db = new Surreal({ engines: createNodeEngines() })
    await db.connect(config.connection)
    await db.use({
      namespace: config.namespace ?? 'default',
      database: config.database ?? 'memory',
    })

    this.db = db
    this.llm = config.llm
    this.embedding = config.embedding
    this.repetitionConfig = config.repetition

    // Set up schema
    this.schema = new SchemaRegistry(db)
    await this.schema.registerCore(config.embedding?.dimension)

    // Create inbox tag
    this.graph = new GraphStore(db)
    try {
      await this.graph.createNodeWithId('tag:inbox', {
        label: 'inbox',
        created_at: Date.now(),
      })
    } catch {
      // Already exists — that's fine
    }

    // Initialize subsystems
    this.searchEngine = new SearchEngine(this.graph, config.search, config.embedding)
    this.scheduler = new Scheduler(
      (domainId: string) => this.createDomainContext(domainId),
      this.events
    )
    this.inboxProcessor = new InboxProcessor(
      this.graph,
      this.domainRegistry,
      this.events,
      (domainId: string) => this.createDomainContext(domainId)
    )

    this.defaultContext = config.context ?? {}

    // Register built-in log domain
    await this.registerDomain(logDomain)
  }

  async registerDomain(domain: DomainConfig): Promise<void> {
    // Register schema if provided
    if (domain.schema) {
      await this.schema.registerDomain(domain.id, domain.schema)
    }

    // Create domain node in SurrealDB
    const domainData: Record<string, unknown> = { name: domain.name }
    if (domain.settings) {
      domainData.settings = domain.settings
    }
    try {
      await this.graph.createNodeWithId(`domain:${domain.id}`, domainData)
    } catch {
      // Already exists — update settings if provided
      if (domain.settings) {
        await this.graph.updateNode(`domain:${domain.id}`, { settings: domain.settings })
      }
    }

    // Register in DomainRegistry
    this.domainRegistry.register(domain)

    // Register schedules
    if (domain.schedules) {
      for (const schedule of domain.schedules) {
        this.scheduler.registerSchedule(domain.id, schedule)
      }
    }
  }

  async ingest(text: string, options?: IngestOptions): Promise<IngestResult> {
    const now = Date.now()
    const tokens = countTokens(text)

    // Generate embedding early (needed for dedup and storage)
    let embeddingVec: number[] | undefined
    if (this.embedding) {
      embeddingVec = await this.embedding.embed(text)
    }

    // Dedup check
    if (!options?.skipDedup && embeddingVec && this.repetitionConfig) {
      const similar = await this.graph.query<(Record<string, unknown> & { score: number })[]>(
        `SELECT *, vector::similarity::cosine(embedding, $queryVec) AS score
         FROM memory
         WHERE embedding IS NOT NONE
         ORDER BY score DESC
         LIMIT 5`,
        { queryVec: embeddingVec }
      )

      if (similar && similar.length > 0) {
        const top = similar[0]
        const existingId = String(top.id)

        if (top.score >= this.repetitionConfig.duplicateThreshold) {
          return { action: 'skipped', existingId }
        }

        if (top.score >= this.repetitionConfig.reinforceThreshold) {
          const memId = await this.createMemoryNode(text, tokens, embeddingVec, options, now)
          await this.graph.relate(memId, 'reinforces', existingId, {
            strength: top.score,
            detected_at: now,
          })
          this.events.emit('reinforced', { id: memId, existingId, similarity: top.score })
          return { action: 'reinforced', id: memId, existingId }
        }
      }
    }

    // Normal storage
    const memId = await this.createMemoryNode(text, tokens, embeddingVec, options, now)
    return { action: 'stored', id: memId }
  }

  private async createMemoryNode(
    text: string,
    tokens: number,
    embeddingVec: number[] | undefined,
    options: IngestOptions | undefined,
    now: number
  ): Promise<string> {
    const memData: Record<string, unknown> = {
      content: text,
      created_at: now,
      token_count: tokens,
    }
    if (options?.eventTime !== undefined) {
      memData.event_time = options.eventTime
    }
    if (embeddingVec) {
      memData.embedding = embeddingVec
    }
    const memId = await this.graph.createNode('memory', memData)

    // Tag with inbox
    await this.graph.relate(memId, 'tagged', 'tag:inbox')

    // Add extra tags
    if (options?.tags) {
      for (const tag of options.tags) {
        const tagId = tag.startsWith('tag:') ? tag : `tag:${tag}`
        try {
          await this.graph.createNodeWithId(tagId, {
            label: tag.startsWith('tag:') ? tag.slice(4) : tag,
            created_at: now,
          })
        } catch {
          // Already exists
        }
        await this.graph.relate(memId, 'tagged', tagId)
      }
    }

    // Determine target domains — log domain always gets ownership
    const targetDomainIds = options?.domains
      ? [...new Set([...options.domains, 'log'])]
      : this.domainRegistry.getAllDomainIds()

    // Assign ownership
    for (const domainId of targetDomainIds) {
      const fullDomainId = domainId.startsWith('domain:') ? domainId : `domain:${domainId}`
      await this.graph.relate(memId, 'owned_by', fullDomainId, {
        attributes: options?.metadata ?? {},
        owned_at: now,
      })
    }

    // Emit event
    this.events.emit('ingested', { id: memId, content: text, tokenCount: tokens })

    return memId
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    // Let domains expand/rank the query
    let expandedQuery = query
    const targetDomains = query.domains ?? this.domainRegistry.getAllDomainIds()

    for (const domainId of targetDomains) {
      const domain = this.domainRegistry.get(domainId)
      if (domain?.search?.expand) {
        const ctx = this.createDomainContext(domainId, query.context)
        expandedQuery = await domain.search.expand(expandedQuery, ctx)
      }
    }

    let result = await this.searchEngine.search(expandedQuery)

    // Let domains rank results
    for (const domainId of targetDomains) {
      const domain = this.domainRegistry.get(domainId)
      if (domain?.search?.rank) {
        result = {
          ...result,
          entries: domain.search.rank(expandedQuery, result.entries),
        }
      }
    }

    return result
  }

  async releaseOwnership(memoryId: string, domainId: string): Promise<void> {
    const fullDomainId = domainId.startsWith('domain:') ? domainId : `domain:${domainId}`

    // Remove owned_by edge
    await this.graph.unrelate(memoryId, 'owned_by', fullDomainId)

    this.events.emit('ownershipRemoved', { memoryId, domainId })

    // Count remaining owners
    const remaining = await this.graph.query<{ count: number }[]>(
      'SELECT count() AS count FROM owned_by WHERE in = $memId GROUP ALL',
      { memId: new StringRecordId(memoryId) }
    )

    const count = (remaining && remaining.length > 0) ? remaining[0].count : 0

    // Delete memory if no owners remain
    if (count === 0) {
      // Remove all edges first
      await this.graph.query(
        'DELETE tagged WHERE in = $memId',
        { memId: new StringRecordId(memoryId) }
      )
      await this.graph.query(
        'DELETE reinforces WHERE in = $memId OR out = $memId',
        { memId: new StringRecordId(memoryId) }
      )
      await this.graph.query(
        'DELETE contradicts WHERE in = $memId OR out = $memId',
        { memId: new StringRecordId(memoryId) }
      )
      await this.graph.query(
        'DELETE summarizes WHERE in = $memId OR out = $memId',
        { memId: new StringRecordId(memoryId) }
      )
      await this.graph.query(
        'DELETE refines WHERE in = $memId OR out = $memId',
        { memId: new StringRecordId(memoryId) }
      )

      // Clean domain-registered edges
      const coreEdges = new Set([
        'tagged', 'owned_by', 'reinforces', 'contradicts',
        'summarizes', 'refines', 'child_of', 'has_rule',
      ])
      for (const edgeName of this.schema.getRegisteredEdgeNames()) {
        if (!coreEdges.has(edgeName)) {
          await this.graph.query(
            `DELETE ${edgeName} WHERE in = $memId OR out = $memId`,
            { memId: new StringRecordId(memoryId) }
          )
        }
      }

      await this.graph.deleteNode(memoryId)

      this.events.emit('deleted', { memoryId })
    }
  }

  private resolveVisibleDomains(domainId: string): string[] {
    const domain = this.domainRegistry.get(domainId)
    // Exclude the built-in log domain from visibility resolution since it
    // auto-owns every memory and would bypass domain filtering.
    // But always include the domain itself so it can see its own data.
    const allIds = this.domainRegistry.getAllDomainIds().filter(id => id !== 'log')
    const ensureSelf = (ids: string[]) =>
      ids.includes(domainId) ? ids : [domainId, ...ids]

    if (!domain?.settings?.includeDomains && !domain?.settings?.excludeDomains) {
      return ensureSelf(allIds)
    }

    if (domain.settings.includeDomains) {
      const allowed = new Set(domain.settings.includeDomains)
      allowed.add(domainId)
      return allIds.filter(id => allowed.has(id))
    }

    if (domain.settings.excludeDomains) {
      const blocked = new Set(domain.settings.excludeDomains)
      blocked.delete(domainId)
      return ensureSelf(allIds.filter(id => !blocked.has(id)))
    }

    return ensureSelf(allIds)
  }

  private mergeContext(requestContext?: RequestContext): RequestContext {
    if (!requestContext) return { ...this.defaultContext }
    return { ...this.defaultContext, ...requestContext }
  }

  createDomainContext(domainId: string, requestContext?: RequestContext): DomainContext {
    const graph = this.graph
    const llm = this.llm
    const embedding = this.embedding
    const events = this.events
    const visibleDomains = this.resolveVisibleDomains(domainId)
    const releaseOwnership = this.releaseOwnership.bind(this)
    const search = this.search.bind(this)
    const mergedContext = this.mergeContext(requestContext)
    const schema = this.schema

    async function isMemoryVisible(memoryId: string): Promise<boolean> {
      const owners = await graph.query<{ out: unknown }[]>(
        'SELECT out FROM owned_by WHERE in = $memId',
        { memId: new StringRecordId(memoryId) }
      )
      if (!owners || owners.length === 0) return false
      return owners.some(o => {
        const ownerDomainId = String(o.out).replace(/^domain:/, '')
        return visibleDomains.includes(ownerDomainId)
      })
    }

    return {
      domain: domainId,
      graph,
      llm,
      requestContext: mergedContext,

      getVisibleDomains(): string[] {
        return [...visibleDomains]
      },

      async getMemory(id: string): Promise<MemoryEntry | null> {
        const node = await graph.getNode(id)
        if (!node) return null
        if (!await isMemoryVisible(id)) return null
        return {
          id: node.id,
          content: node.content as string,
          eventTime: (node.event_time as number | null) ?? null,
          createdAt: node.created_at as number,
          tokenCount: node.token_count as number,
        }
      },

      async getMemories(filter?: MemoryFilter): Promise<MemoryEntry[]> {
        // Short-circuit: batch fetch by IDs
        if (filter?.ids) {
          const results: MemoryEntry[] = []
          for (const id of filter.ids) {
            const entry = await this.getMemory(id)
            if (entry) results.push(entry)
          }
          return results
        }

        // Build composable query for owned memories
        const requestedDomains = filter?.domains ?? visibleDomains
        const targetDomains = requestedDomains.filter(d => visibleDomains.includes(d))
        const domainRefs = targetDomains.map(d =>
          new StringRecordId(d.startsWith('domain:') ? d : `domain:${d}`)
        )

        const conditions: string[] = ['out IN $domainRefs']
        const vars: Record<string, unknown> = { domainRefs }

        if (filter?.since != null) {
          conditions.push('owned_at >= $since')
          vars.since = filter.since
        }

        if (filter?.attributes) {
          for (const [key, value] of Object.entries(filter.attributes)) {
            const paramName = `attr_${key}`
            conditions.push(`attributes.${key} = $${paramName}`)
            vars[paramName] = value
          }
        }

        const where = conditions.join(' AND ')
        const limitClause = filter?.limit != null ? ' LIMIT $limit' : ''
        if (filter?.limit != null) vars.limit = filter.limit

        const surql = `SELECT in FROM owned_by WHERE ${where}${limitClause}`
        const rows = await graph.query<{ in: unknown }[]>(surql, vars)
        if (!rows) return []

        let memoryIds = rows.map(r => String(r.in))

        // Apply tag filter if specified
        if (filter?.tags && filter.tags.length > 0) {
          const tagRefs = filter.tags.map(t =>
            new StringRecordId(t.startsWith('tag:') ? t : `tag:${t}`)
          )
          const taggedRows = await graph.query<{ in: unknown }[]>(
            `SELECT in FROM tagged WHERE in IN $memIds AND out IN $tagRefs`,
            { memIds: memoryIds.map(id => new StringRecordId(id)), tagRefs }
          )
          if (taggedRows) {
            const taggedIds = new Set(taggedRows.map(r => String(r.in)))
            memoryIds = memoryIds.filter(id => taggedIds.has(id))
          } else {
            memoryIds = []
          }
        }

        const results: MemoryEntry[] = []
        for (const id of memoryIds) {
          const entry = await this.getMemory(id)
          if (entry) results.push(entry)
        }
        return results
      },

      async writeMemory(entry: WriteMemoryEntry): Promise<string> {
        const tokens = countTokens(entry.content)
        const now = Date.now()

        const memData: Record<string, unknown> = {
          content: entry.content,
          created_at: now,
          token_count: tokens,
        }
        if (entry.eventTime !== undefined) {
          memData.event_time = entry.eventTime
        }
        if (embedding) {
          memData.embedding = await embedding.embed(entry.content)
        }

        const memId = await graph.createNode('memory', memData)

        if (entry.tags) {
          for (const tag of entry.tags) {
            await this.tagMemory(memId, tag)
          }
        }

        if (entry.references) {
          for (const ref of entry.references) {
            await graph.relate(memId, ref.type, ref.targetId)
          }
        }

        const ownerDomain = entry.ownership?.domain ?? domainId
        await this.addOwnership(memId, ownerDomain, entry.ownership?.attributes)

        return memId
      },

      async addTag(path: string): Promise<void> {
        const parts = path.split('/')
        let parentId: string | null = null
        for (const part of parts) {
          const tagId = `tag:${part}`
          try {
            await graph.createNodeWithId(tagId, {
              label: part,
              created_at: Date.now(),
            })
          } catch {
            // Already exists
          }
          if (parentId) {
            await graph.relate(tagId, 'child_of', parentId)
          }
          parentId = tagId
        }
      },

      async tagMemory(memoryId: string, tagId: string): Promise<void> {
        const fullTagId = tagId.startsWith('tag:') ? tagId : `tag:${tagId}`
        await graph.relate(memoryId, 'tagged', fullTagId)
        events.emit('tagAssigned', { memoryId, tagId: fullTagId })
      },

      async untagMemory(memoryId: string, tagId: string): Promise<void> {
        const fullTagId = tagId.startsWith('tag:') ? tagId : `tag:${tagId}`
        await graph.unrelate(memoryId, 'tagged', fullTagId)
        events.emit('tagRemoved', { memoryId, tagId: fullTagId })
      },

      async getTagDescendants(tagPath: string): Promise<string[]> {
        const tagId = tagPath.startsWith('tag:') ? tagPath : `tag:${tagPath}`
        const allDescendants = new Set<string>()
        let frontier = [tagId]

        for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
          const refs = frontier.map(id => new StringRecordId(id))
          const children = await graph.query<string[]>(
            'SELECT VALUE id FROM tag WHERE ->child_of->tag CONTAINSANY $parentIds',
            { parentIds: refs }
          )
          if (!children || children.length === 0) break
          frontier = []
          for (const child of children) {
            const childStr = String(child)
            if (!allDescendants.has(childStr) && childStr !== tagId) {
              allDescendants.add(childStr)
              frontier.push(childStr)
            }
          }
        }
        return [...allDescendants]
      },

      async addOwnership(
        memoryId: string,
        targetDomainId: string,
        attributes?: Record<string, unknown>
      ): Promise<void> {
        const fullDomainId = targetDomainId.startsWith('domain:') ? targetDomainId : `domain:${targetDomainId}`
        await graph.relate(memoryId, 'owned_by', fullDomainId, {
          attributes: attributes ?? {},
          owned_at: Date.now(),
        })
        events.emit('ownershipAdded', { memoryId, domainId: targetDomainId })
      },

      async releaseOwnership(memoryId: string, targetDomainId: string): Promise<void> {
        await releaseOwnership(memoryId, targetDomainId)
      },

      async updateAttributes(memoryId: string, attributes: Record<string, unknown>): Promise<void> {
        const fullDomainId = domainId.startsWith('domain:') ? domainId : `domain:${domainId}`
        await graph.query(
          'UPDATE owned_by SET attributes = $attrs WHERE in = $memId AND out = $domainId',
          {
            memId: new StringRecordId(memoryId),
            domainId: new StringRecordId(fullDomainId),
            attrs: attributes,
          }
        )
      },

      async search(query: Omit<SearchQuery, 'domains'>): Promise<SearchResult> {
        return search({ ...query, domains: visibleDomains })
      },

      async getMeta(key: string): Promise<string | null> {
        const metaId = `meta:${domainId}_${key}`
        const node = await graph.getNode(metaId)
        if (!node) return null
        return (node.value as string) ?? null
      },

      async setMeta(key: string, value: string): Promise<void> {
        const metaId = `meta:${domainId}_${key}`
        try {
          await graph.createNodeWithId(metaId, { value })
        } catch {
          await graph.updateNode(metaId, { value })
        }
      },

      async getMemoryTags(memoryId: string): Promise<string[]> {
        if (!await isMemoryVisible(memoryId)) return []
        const rows = await graph.query<string[]>(
          'SELECT VALUE out.label FROM tagged WHERE in = $memId',
          { memId: new StringRecordId(memoryId) }
        )
        return (rows ?? []).filter((label): label is string => typeof label === 'string')
      },

      async getNodeEdges(nodeId: string, direction?: 'in' | 'out' | 'both'): Promise<Edge[]> {
        const dir = direction ?? 'both'
        const conditions: string[] = []
        // SurrealDB edge.in = source, edge.out = target
        // direction 'out' = edges going out from this node (node is source → in = nodeId)
        // direction 'in' = edges coming into this node (node is target → out = nodeId)
        if (dir === 'out' || dir === 'both') conditions.push('in = $nodeId')
        if (dir === 'in' || dir === 'both') conditions.push('out = $nodeId')
        const where = conditions.join(' OR ')

        const edgeNames = schema.getRegisteredEdgeNames()
        const coreEdges = ['tagged', 'owned_by', 'reinforces', 'contradicts', 'summarizes', 'refines', 'child_of', 'has_rule']
        const allEdges = [...new Set([...coreEdges, ...edgeNames])]

        const results: Edge[] = []
        const nodeRef = new StringRecordId(nodeId)
        for (const edgeName of allEdges) {
          const rows = await graph.query<Edge[]>(
            `SELECT * FROM ${edgeName} WHERE ${where}`,
            { nodeId: nodeRef }
          )
          if (rows) results.push(...rows)
        }

        // Filter edges that connect to memory nodes from non-visible domains
        const filtered: Edge[] = []
        for (const edge of results) {
          const inId = String(edge.in)
          const outId = String(edge.out)
          // Determine the "other" node — the one that isn't the queried node
          const otherId = inId === nodeId ? outId : inId

          // Only check visibility for memory nodes
          if (otherId.startsWith('memory:')) {
            if (await isMemoryVisible(otherId)) {
              filtered.push(edge)
            }
          } else {
            // Non-memory nodes (tags, domains, user nodes, etc.) pass through
            filtered.push(edge)
          }
        }

        return filtered
      },
    }
  }

  async buildContext(text: string, options?: ContextOptions): Promise<ContextResult> {
    const budgetTokens = options?.budgetTokens ?? 4000
    const limit = options?.maxMemories ?? 50

    // Check if a target domain has custom buildContext
    if (options?.domains?.length === 1) {
      const domain = this.domainRegistry.get(options.domains[0])
      if (domain?.buildContext) {
        const ctx = this.createDomainContext(options.domains[0], options?.context)
        return domain.buildContext(text, budgetTokens, ctx)
      }
    }

    // Search with hybrid mode
    const result = await this.search({
      text,
      limit,
      domains: options?.domains,
    })

    // Apply token budget
    const fitted = applyTokenBudget(
      result.entries.map(e => ({ ...e, tokenCount: countTokens(e.content) })),
      budgetTokens
    )

    // Format as numbered plain text
    const context = fitted
      .map((m, i) => `[${i + 1}] ${m.content}`)
      .join('\n\n')

    const totalTokens = countTokens(context)

    return { context, memories: fitted, totalTokens }
  }

  async ask(question: string, options?: AskOptions): Promise<AskResult> {
    const budgetTokens = options?.budgetTokens ?? 8000
    const limit = options?.limit ?? 30
    const maxRounds = 3

    const allMemories = new Map<string, ScoredMemory>()
    let rounds = 0

    // Get available top-level tags for the system prompt
    const topTags = await this.graph.query<{ label: string }[]>(
      'SELECT label FROM tag WHERE ->child_of->tag IS NONE OR array::len(->child_of->tag) = 0'
    )
    const tagList = topTags
      ? topTags
          .map(t => t.label)
          .filter(l => l !== 'inbox')
          .join(', ')
      : ''

    const systemPrompt = `You are a search assistant. Given a question, decide how to search a memory database.

Available search capabilities:
- "text": fulltext search terms (keywords or phrases)
- "tags": filter by tag categories (available: ${tagList})

Respond with JSON only. Either:
1. A query plan: { "text": "search terms", "tags": ["tag1"], "reasoning": "why" }
2. A final answer: { "answer": "your analytical response" }

If you have enough information from previous search results, respond with an answer.
Otherwise, respond with a query plan to find more relevant information.`

    const history: string[] = [`Question: ${question}`]

    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1

      const prompt = `${systemPrompt}\n\n${history.join('\n\n')}`
      if (!this.llm.generate) {
        throw new Error('LLM adapter must implement generate() to use ask()')
      }
      const response = await this.llm.generate(prompt)

      // Parse LLM response
      let parsed: Record<string, unknown>
      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/)
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) as Record<string, unknown> : {}
      } catch {
        // If parsing fails, treat as final answer
        parsed = { answer: response }
      }

      // Check if LLM gave a final answer
      if (typeof parsed.answer === 'string') {
        break
      }

      // Execute query plan
      const searchQuery: SearchQuery = {
        text: typeof parsed.text === 'string' ? parsed.text : question,
        tags: Array.isArray(parsed.tags) ? parsed.tags as string[] : options?.tags,
        limit,
        domains: options?.domains,
      }

      const result = await this.search(searchQuery)

      // Accumulate memories (dedup by ID)
      for (const entry of result.entries) {
        if (!allMemories.has(entry.id)) {
          allMemories.set(entry.id, entry)
        }
      }

      // Add results summary to history for next round
      const resultSummary = result.entries
        .slice(0, 10)
        .map((e, i) => `  [${i + 1}] (score: ${e.score.toFixed(3)}) ${e.content.slice(0, 200)}`)
        .join('\n')
      history.push(`Round ${rounds} results (${result.entries.length} found):\n${resultSummary}`)
    }

    // Apply token budget to accumulated memories
    const sortedMemories = [...allMemories.values()]
      .sort((a, b) => b.score - a.score)

    const fitted = applyTokenBudget(
      sortedMemories.map(e => ({ ...e, tokenCount: countTokens(e.content) })),
      budgetTokens
    )

    // Final synthesis
    if (!this.llm.synthesize) {
      throw new Error('LLM adapter must implement synthesize() to use ask()')
    }
    const answer = await this.llm.synthesize(question, fitted)

    return { answer, memories: fitted, rounds }
  }

  getGraph(): GraphStore {
    return this.graph
  }

  getDomainRegistry(): DomainRegistry {
    return this.domainRegistry
  }

  getEvents(): EventEmitter {
    return this.events
  }

  startProcessing(intervalMs?: number): void {
    this.inboxProcessor.start(intervalMs)
    this.scheduler.start()
  }

  stopProcessing(): void {
    this.inboxProcessor.stop()
    this.scheduler.stop()
  }

  async processInbox(): Promise<boolean> {
    return this.inboxProcessor.processNext()
  }

  async close(): Promise<void> {
    this.stopProcessing()
    if (this.db) {
      await this.db.close()
      this.db = null
    }
  }
}

export { MemoryEngine }
