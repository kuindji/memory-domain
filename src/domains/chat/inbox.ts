import type { OwnedMemory, DomainContext } from '../../core/types.ts'
import { CHAT_TAG, CHAT_MESSAGE_TAG } from './types.ts'
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from '../topic/types.ts'

/**
 * Escapes a tag label containing `/` for use as a SurrealDB record ID.
 * SurrealDB interprets `/` in bare record IDs as a path separator,
 * so hierarchical tags like `chat/message` must be backtick-escaped.
 */
function tagRecordId(label: string): string {
  if (label.includes('/')) {
    return `tag:\`${label}\``
  }
  return `tag:${label}`
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

  // Ensure tag nodes exist (backtick-escape hierarchical tag IDs)
  const chatTagId = tagRecordId(CHAT_TAG)
  const chatMessageTagId = tagRecordId(CHAT_MESSAGE_TAG)

  try {
    await context.graph.createNodeWithId(chatTagId, { label: CHAT_TAG, created_at: Date.now() })
  } catch { /* already exists */ }
  try {
    await context.graph.createNodeWithId(chatMessageTagId, { label: CHAT_MESSAGE_TAG, created_at: Date.now() })
  } catch { /* already exists */ }
  // Establish tag hierarchy: chat/message is child of chat
  try {
    await context.graph.relate(chatMessageTagId, 'child_of', chatTagId)
  } catch { /* already related */ }

  // Tag the memory using escaped tag IDs
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

      // Update topic attributes via topic domain context pattern
      // We need to update the owned_by edge attributes for the topic domain
      const fullTopicDomainId = `domain:${TOPIC_DOMAIN_ID}`
      await context.graph.query(
        'UPDATE owned_by SET attributes.mentionCount = $count, attributes.lastMentionedAt = $now WHERE in = $memId AND out = $domainId',
        {
          memId: topicId,
          domainId: fullTopicDomainId,
          count: currentCount + 1,
          now: Date.now(),
        }
      )
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
