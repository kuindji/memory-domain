import type { DomainContext } from '../../core/types.ts'
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from '../topic/types.ts'
import type { MemoryClassification } from './types.ts'
import { CLASSIFICATION_TAGS } from './types.ts'

/**
 * Ensures a tag node exists in the graph with the given label.
 */
export async function ensureTag(context: DomainContext, label: string): Promise<string> {
  const tagId = label.includes('/') ? `tag:\`${label}\`` : `tag:${label}`
  try {
    await context.graph.createNodeWithId(tagId, { label, created_at: Date.now() })
  } catch { /* already exists */ }
  return tagId
}

/**
 * Searches for an existing entity node by type and name, creates if not found.
 * Returns the node ID.
 */
export async function findOrCreateEntity(
  context: DomainContext,
  type: string,
  name: string,
  fields?: Record<string, unknown>,
): Promise<string> {
  // Search for existing entity by name
  const results = await context.graph.query<Array<{ id: string }>>(
    `SELECT id FROM type::table($type) WHERE name = $name LIMIT 1`,
    { type, name },
  )

  if (Array.isArray(results) && results.length > 0) {
    return results[0].id
  }

  // Create new entity node
  return context.graph.createNode(type, { name, ...fields })
}

/**
 * Extracts topics from content and links them to a memory via about_topic edges.
 * Same pattern as chat domain inbox topic linking.
 */
export async function linkToTopics(
  context: DomainContext,
  memoryId: string,
  content: string,
): Promise<void> {
  const topicNames = await context.llmAt('low').extract(content)

  for (const topicName of topicNames) {
    const searchResult = await context.search({
      text: topicName,
      tags: [TOPIC_TAG],
      minScore: 0.8,
    })

    let topicId: string

    if (searchResult.entries.length > 0) {
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

    await context.graph.relate(memoryId, 'about_topic', topicId, { domain: context.domain })
  }
}

/**
 * Maps a classification string to its corresponding tag path.
 */
export function classificationToTag(classification: MemoryClassification): string {
  return CLASSIFICATION_TAGS[classification]
}
