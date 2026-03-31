import { StringRecordId } from 'surrealdb'
import type { DomainContext } from '../../core/types.ts'
import type { ChatDomainOptions } from './types.ts'
import {
  CHAT_DOMAIN_ID,
  CHAT_TAG,
  CHAT_EPISODIC_TAG,
  DEFAULT_WORKING_CAPACITY,
  DEFAULT_WORKING_MAX_AGE,
} from './types.ts'

interface WorkingMemoryRow {
  in: string
  attributes: Record<string, unknown>
}

/**
 * Ensures a tag node exists in the graph with the given label.
 */
async function ensureTag(context: DomainContext, label: string): Promise<string> {
  const tagId = label.includes('/') ? `tag:\`${label}\`` : `tag:${label}`
  try {
    await context.graph.createNodeWithId(tagId, { label, created_at: Date.now() })
  } catch { /* already exists */ }
  return tagId
}

export async function promoteWorkingMemory(context: DomainContext, options?: ChatDomainOptions): Promise<void> {
  const capacity = options?.workingMemoryCapacity ?? DEFAULT_WORKING_CAPACITY
  const maxAge = options?.workingMemoryMaxAge ?? DEFAULT_WORKING_MAX_AGE

  // Get all working memories owned by the chat domain with layer='working'
  const rows = await context.graph.query<WorkingMemoryRow[]>(
    'SELECT in, attributes FROM owned_by WHERE out = $domainId AND attributes.layer = "working"',
    { domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`) }
  )
  if (!rows || rows.length === 0) return

  // Group by userId + chatSessionId
  const groups = new Map<string, { memId: string; attrs: Record<string, unknown> }[]>()
  for (const row of rows) {
    const memId = String(row.in)
    const attrs = row.attributes
    const userId = typeof attrs.userId === 'string' ? attrs.userId : ''
    const chatSessionId = typeof attrs.chatSessionId === 'string' ? attrs.chatSessionId : ''
    const key = `${userId}::${chatSessionId}`

    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push({ memId, attrs })
  }

  const now = Date.now()

  for (const group of groups.values()) {
    // Determine which memories to promote
    const toPromote: { memId: string; attrs: Record<string, unknown> }[] = []

    // Sort by messageIndex ascending so we promote oldest first
    group.sort((a, b) => {
      const idxA = (a.attrs.messageIndex as number) ?? 0
      const idxB = (b.attrs.messageIndex as number) ?? 0
      return idxA - idxB
    })

    // Check for age-based promotion
    for (const item of group) {
      const memory = await context.getMemory(item.memId)
      if (memory && (now - memory.createdAt) > maxAge) {
        toPromote.push(item)
      }
    }

    // Check for capacity-based promotion (oldest first)
    if (group.length > capacity) {
      const overCapacityCount = group.length - capacity
      for (let i = 0; i < overCapacityCount; i++) {
        if (!toPromote.some(p => p.memId === group[i].memId)) {
          toPromote.push(group[i])
        }
      }
    }

    if (toPromote.length === 0) continue

    // Collect content of memories to promote
    const contents: string[] = []
    const promotedIds: string[] = []
    for (const item of toPromote) {
      const memory = await context.getMemory(item.memId)
      if (memory) {
        contents.push(memory.content)
        promotedIds.push(item.memId)
      }
    }

    if (contents.length === 0) continue

    // Extract key facts via LLM
    const facts = await context.llm.extract(contents.join('\n'))
    if (!facts || facts.length === 0) {
      // Even if no facts extracted, release ownership on promoted memories
      for (const memId of promotedIds) {
        await context.releaseOwnership(memId, CHAT_DOMAIN_ID)
      }
      continue
    }

    // Get session attributes from the first promoted memory for context
    const sampleAttrs = toPromote[0].attrs
    const userId = typeof sampleAttrs.userId === 'string' ? sampleAttrs.userId : ''
    const chatSessionId = typeof sampleAttrs.chatSessionId === 'string' ? sampleAttrs.chatSessionId : ''

    // Ensure tag nodes exist
    const chatTagId = await ensureTag(context, CHAT_TAG)
    const episodicTagId = await ensureTag(context, CHAT_EPISODIC_TAG)
    try {
      await context.graph.relate(episodicTagId, 'child_of', chatTagId)
    } catch { /* already related */ }

    // Create episodic memories for each extracted fact
    for (const fact of facts) {
      const episodicId = await context.writeMemory({
        content: fact,
        tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
        ownership: {
          domain: CHAT_DOMAIN_ID,
          attributes: {
            layer: 'episodic',
            userId,
            chatSessionId,
            weight: 1.0,
          },
        },
      })

      // Link episodic → source working memories via summarizes edges
      for (const memId of promotedIds) {
        await context.graph.relate(episodicId, 'summarizes', memId)
      }
    }

    // Release ownership on promoted working memories
    for (const memId of promotedIds) {
      await context.releaseOwnership(memId, CHAT_DOMAIN_ID)
    }
  }
}

export async function consolidateEpisodic(_context: DomainContext, _options?: ChatDomainOptions): Promise<void> {
  // Stub — implemented in Task 9
}

export async function pruneDecayed(_context: DomainContext, _options?: ChatDomainOptions): Promise<void> {
  // Stub — implemented in Task 10
}
