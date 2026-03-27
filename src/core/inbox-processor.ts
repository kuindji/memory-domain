import { StringRecordId } from 'surrealdb'
import type { GraphStore } from './graph-store.ts'
import type { DomainRegistry } from './domain-registry.ts'
import type { EventEmitter } from './events.ts'
import type { DomainContext, OwnedMemory, MemoryEntry } from './types.ts'

interface RawMemoryRow {
  id: { tb: string; id: string } | string
  content: string
  event_time: number | null
  created_at: number
  token_count: number
}

interface RawOwnedByEdge {
  out: { tb: string; id: string } | string
  attributes?: Record<string, unknown>
  owned_at?: number
}

interface RawTagRow {
  id: { tb: string; id: string } | string
  label: string
}

class InboxProcessor {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private store: GraphStore,
    private domainRegistry: DomainRegistry,
    private events: EventEmitter,
    private contextFactory: (domainId: string) => DomainContext
  ) {}

  async processNext(): Promise<boolean> {
    // Find oldest inbox-tagged memory
    const rows = await this.store.query<RawMemoryRow[]>(
      'SELECT id, content, event_time, created_at, token_count FROM memory WHERE ->tagged->tag CONTAINS tag:inbox ORDER BY created_at ASC LIMIT 1'
    )

    if (!rows || rows.length === 0) return false

    const raw = rows[0]
    const memId = String(raw.id)

    const memory: MemoryEntry = {
      id: memId,
      content: raw.content,
      eventTime: raw.event_time,
      createdAt: raw.created_at,
      tokenCount: raw.token_count,
    }

    // Find owning domains via owned_by edges
    const ownedByEdges = await this.store.query<RawOwnedByEdge[]>(
      'SELECT out, attributes, owned_at FROM owned_by WHERE in = $memId',
      { memId: new StringRecordId(memId) }
    )

    if (!ownedByEdges || ownedByEdges.length === 0) return false

    // Get tags for the memory
    const tagRows = await this.store.traverse<RawTagRow>(memId, '->tagged->tag')
    const tags = tagRows
      .map(t => String(t.id))
      .filter(id => id !== 'tag:inbox')

    // Process with each owning domain
    for (const edge of ownedByEdges) {
      const domainId = String(edge.out)
      const domainIdShort = domainId.startsWith('domain:') ? domainId.slice(7) : domainId
      const domain = this.domainRegistry.get(domainIdShort)
      if (!domain) continue

      const owned: OwnedMemory = {
        memory,
        domainAttributes: edge.attributes ?? {},
        tags,
      }

      const ctx = this.contextFactory(domainIdShort)
      await domain.processInboxItem(owned, ctx)
    }

    // Remove inbox tag
    await this.store.unrelate(memId, 'tagged', 'tag:inbox')

    // Emit event
    this.events.emit('inboxProcessed', { memoryId: memId })

    return true
  }

  start(intervalMs = 5000, batchLimit = 50): void {
    if (this.timer) return

    this.timer = setInterval(async () => {
      let processed = 0
      while (processed < batchLimit) {
        const didProcess = await this.processNext()
        if (!didProcess) break
        processed++
      }
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export { InboxProcessor }
