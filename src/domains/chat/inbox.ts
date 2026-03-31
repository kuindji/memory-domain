import type { OwnedMemory, DomainContext } from '../../core/types.ts'
import { CHAT_TAG, CHAT_MESSAGE_TAG } from './types.ts'
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from '../topic/types.ts'

/**
 * Ensures a tag node exists in the graph with the given label.
 * Hierarchical tags (containing `/`) need backtick-escaping in SurrealDB
 * record IDs to prevent `/` being interpreted as a path separator.
 */
async function ensureTag(context: DomainContext, label: string): Promise<string> {
  const tagId = label.includes('/') ? `tag:\`${label}\`` : `tag:${label}`
  try {
    await context.graph.createNodeWithId(tagId, { label, created_at: Date.now() })
  } catch { /* already exists */ }
  return tagId
}

export async function processInboxItem(entry: OwnedMemory, context: DomainContext): Promise<void> {
  const userId = context.requestContext.userId as string | undefined
  const chatSessionId = context.requestContext.chatSessionId as string | undefined

  if (!userId || !chatSessionId) return

  const role = (entry.domainAttributes.role as string | undefined) ?? 'user'

  // Count existing working memories for this session to determine messageIndex
  const existing = await context.getMemories({
    tags: [CHAT_MESSAGE_TAG],
    attributes: { chatSessionId, userId },
  })
  const messageIndex = existing.length

  // Update ownership attributes
  await context.updateAttributes(entry.memory.id, {
    role,
    layer: 'working',
    chatSessionId,
    userId,
    messageIndex,
  })

  // Ensure tag nodes exist and tag the memory
  const chatTagId = await ensureTag(context, CHAT_TAG)
  const chatMessageTagId = await ensureTag(context, CHAT_MESSAGE_TAG)
  try {
    await context.graph.relate(chatMessageTagId, 'child_of', chatTagId)
  } catch { /* already related */ }
  await context.tagMemory(entry.memory.id, chatTagId)
  await context.tagMemory(entry.memory.id, chatMessageTagId)

  // Extract topics from message content
  const topicNames = await context.llm.extract(entry.memory.content)

  for (const topicName of topicNames) {
    // Search for existing similar topic
    const searchResult = await context.search({
      text: topicName,
      tags: [TOPIC_TAG],
      minScore: 0.8,
    })

    let topicId: string

    if (searchResult.entries.length > 0) {
      // Found existing topic — increment mentionCount
      topicId = searchResult.entries[0].id
      const topicAttrs = searchResult.entries[0].domainAttributes[TOPIC_DOMAIN_ID] as
        Record<string, unknown> | undefined
      const currentCount = (topicAttrs?.mentionCount as number | undefined) ?? 0

      await context.updateAttributes(topicId, {
        ...topicAttrs,
        mentionCount: currentCount + 1,
        lastMentionedAt: Date.now(),
      })
    } else {
      // Create new topic
      topicId = await context.writeMemory({
        content: topicName,
        tags: [TOPIC_TAG],
        ownership: {
          domain: TOPIC_DOMAIN_ID,
          attributes: {
            name: topicName,
            status: 'active',
            mentionCount: 1,
            lastMentionedAt: Date.now(),
            createdBy: context.domain,
          },
        },
      })
    }

    // Link message to topic via about_topic edge
    await context.graph.relate(entry.memory.id, 'about_topic', topicId, { domain: context.domain })
  }
}
