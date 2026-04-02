import type { DomainContext } from '../../core/types.ts'
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from '../topic/types.ts'
import type { MemoryClassification } from './types.ts'
import { CLASSIFICATION_TAGS } from './types.ts'

function logProjectWarning(scope: string, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error)
  console.warn(`[memory-domain warning] ${scope}: ${errorMessage}`)
}

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

import type { OwnedMemory } from '../../core/types.ts'

const BATCH_TOPIC_EXTRACTION_SCHEMA = JSON.stringify({
  type: 'array',
  items: {
    type: 'object',
    properties: {
      index: { type: 'number', description: 'Zero-based index of the item' },
      topics: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topic names extracted from this item',
      },
    },
    required: ['index', 'topics'],
  },
})

const BATCH_TOPIC_EXTRACTION_PROMPT =
  'Extract key topics from each numbered item below. ' +
  'Return topics as short noun phrases (1-4 words). ' +
  'Only extract meaningful, specific topics — not generic words.'

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
    const trimmed = topicName.trim()
    if (!trimmed) continue
    await linkSingleTopic(context, memoryId, trimmed)
  }
}

/**
 * Batch extracts topics from multiple entries in a single LLM call,
 * then links each entry to its extracted topics.
 */
export async function linkToTopicsBatch(
  context: DomainContext,
  entries: OwnedMemory[],
): Promise<void> {
  const topicsMap = await batchExtractTopics(context, entries)

  for (const entry of entries) {
    const topicNames = topicsMap.get(entry.memory.id) ?? []
    for (const topicName of topicNames) {
      const trimmed = topicName.trim()
      if (!trimmed) continue
      await linkSingleTopic(context, entry.memory.id, trimmed)
    }
  }
}

async function batchExtractTopics(
  context: DomainContext,
  entries: OwnedMemory[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  const llm = context.llmAt('low')

  const numberedItems = entries
    .map((e, i) => `${i}. ${e.memory.content}`)
    .join('\n\n')

  if (llm.extractStructured) {
    try {
      const raw = await llm.extractStructured(
        numberedItems,
        BATCH_TOPIC_EXTRACTION_SCHEMA,
        BATCH_TOPIC_EXTRACTION_PROMPT,
      ) as Array<{ index: number; topics: string[] }>

      for (const item of raw) {
        if (item.index >= 0 && item.index < entries.length && Array.isArray(item.topics)) {
          result.set(entries[item.index].memory.id, item.topics)
        }
      }
      return result
    } catch (error) {
      logProjectWarning('project.inbox.topicExtraction.extractStructured', error)
      // Fall through to sequential fallback
    }
  }

  // Fallback: sequential extract calls
  for (const entry of entries) {
    try {
      const topics = await llm.extract(entry.memory.content)
      result.set(entry.memory.id, topics)
    } catch (error) {
      logProjectWarning('project.inbox.topicExtraction.extract', error)
      result.set(entry.memory.id, [])
    }
  }

  return result
}

async function linkSingleTopic(
  context: DomainContext,
  memoryId: string,
  topicName: string,
): Promise<void> {
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

/**
 * Maps a classification string to its corresponding tag path.
 */
export function classificationToTag(classification: MemoryClassification): string {
  return CLASSIFICATION_TAGS[classification]
}
