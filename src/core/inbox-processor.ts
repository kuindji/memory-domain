import { StringRecordId } from 'surrealdb'
import type { GraphStore } from './graph-store.ts'
import type { DomainRegistry } from './domain-registry.ts'
import type { EventEmitter } from './events.ts'
import type { DomainContext, OwnedMemory, MemoryEntry, Node } from './types.ts'

interface RecordIdLike {
  tb: string
  id: string
  toString(): string
}

interface RawMemoryRow {
  id: RecordIdLike | string
  content: string
  event_time: number | null
  created_at: number
  token_count: number
}

interface RawOwnedByEdge {
  out: RecordIdLike | string
  attributes?: Record<string, unknown>
  owned_at?: number
}

interface RawTagRow {
  id: RecordIdLike | string
  label: string
}

interface InboxLockPayload {
  lockedAt: number
}

interface InboxProcessorOptions {
  intervalMs?: number
  batchLimit?: number
  staleAfterMs?: number
}

class InboxProcessor {
  private timeout: ReturnType<typeof setTimeout> | null = null
  private running = false
  private intervalMs = 5000
  private batchLimit = 50
  private staleAfterMs = 30_000

  constructor(
    private store: GraphStore,
    private domainRegistry: DomainRegistry,
    private events: EventEmitter,
    private contextFactory: (domainId: string, requestContext?: Record<string, unknown>) => DomainContext
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
      try {
        await domain.processInboxItem(owned, ctx)
      } catch (err) {
        this.events.emit('error', {
          source: 'inbox',
          domainId: domainIdShort,
          memoryId: memId,
          error: err,
        })
      }
    }

    // Remove inbox tag
    await this.store.unrelate(memId, 'tagged', 'tag:inbox')

    // Emit event
    this.events.emit('inboxProcessed', { memoryId: memId })

    return true
  }

  start(options?: InboxProcessorOptions): void {
    if (this.running) return
    if (options?.intervalMs != null) this.intervalMs = options.intervalMs
    if (options?.batchLimit != null) this.batchLimit = options.batchLimit
    if (options?.staleAfterMs != null) this.staleAfterMs = options.staleAfterMs
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = null
    }
  }

  async tick(): Promise<void> {
    try {
      const acquired = await this.acquireLock()
      if (!acquired) return

      let processed = 0
      while (processed < this.batchLimit) {
        const didProcess = await this.processNext()
        if (!didProcess) break
        processed++
      }
    } catch (err) {
      this.events.emit('error', { source: 'inbox', error: err })
    } finally {
      await this.releaseLock()
      this.scheduleNext()
    }
  }

  private scheduleNext(): void {
    if (!this.running) return
    this.timeout = setTimeout(() => { void this.tick() }, this.intervalMs)
  }

  private async acquireLock(): Promise<boolean> {
    const existing = await this.store.getNode<Node & { value?: string }>('meta:_inbox_lock')

    if (existing?.value) {
      const payload: InboxLockPayload = JSON.parse(existing.value)
      const age = Date.now() - payload.lockedAt
      if (age < this.staleAfterMs) {
        return false
      }
    }

    const payload: InboxLockPayload = { lockedAt: Date.now() }

    try {
      if (existing) {
        await this.store.updateNode('meta:_inbox_lock', { value: JSON.stringify(payload) })
      } else {
        await this.store.createNodeWithId('meta:_inbox_lock', { value: JSON.stringify(payload) })
      }
    } catch {
      return false
    }

    return true
  }

  private async releaseLock(): Promise<void> {
    try {
      await this.store.deleteNode('meta:_inbox_lock')
    } catch {
      // Best-effort — staleness will handle it
    }
  }
}

export { InboxProcessor }
