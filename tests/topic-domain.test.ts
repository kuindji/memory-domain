import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'
import { mergeSimilarTopics } from '../src/domains/topic/schedules.ts'
import { TOPIC_TAG, TOPIC_DOMAIN_ID, DEFAULT_MERGE_INTERVAL_MS } from '../src/domains/topic/types.ts'
import { createTopicDomain, topicDomain } from '../src/domains/topic/index.ts'
import type { DomainConfig, OwnedMemory, DomainContext } from '../src/core/types.ts'

const testTopicDomain: DomainConfig = {
  id: 'topic',
  name: 'Topic',
  schema: {
    nodes: [],
    edges: [
      { name: 'subtopic_of', from: 'memory', to: 'memory' },
      { name: 'related_to', from: 'memory', to: 'memory', fields: [{ name: 'strength', type: 'float' }] },
      { name: 'about_topic', from: 'memory', to: 'memory', fields: [{ name: 'domain', type: 'string' }] },
    ],
  },
  async processInboxItem(_entry: OwnedMemory, _context: DomainContext) {},
}

describe('Topic domain - merge schedule', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(testTopicDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('merge-similar marks duplicate topic as merged', async () => {
    const context = engine.createDomainContext(TOPIC_DOMAIN_ID)

    const topicAId = await context.writeMemory({
      content: 'TypeScript programming language',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'TypeScript',
          status: 'active',
          mentionCount: 3,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    const topicBId = await context.writeMemory({
      content: 'TypeScript programming language',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'TypeScript duplicate',
          status: 'active',
          mentionCount: 1,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    await mergeSimilarTopics(context)

    // Search for the merged topic to check its attributes
    const searchResult = await context.search({ text: 'TypeScript programming language', tags: [TOPIC_TAG] })
    const entries = searchResult.entries

    const topicA = entries.find(e => e.id === topicAId)
    const topicB = entries.find(e => e.id === topicBId)

    expect(topicA).toBeDefined()
    expect(topicB).toBeDefined()

    const topicAAttrs = topicA!.domainAttributes[TOPIC_DOMAIN_ID]
    const topicBAttrs = topicB!.domainAttributes[TOPIC_DOMAIN_ID]

    // topicA has higher mentionCount, should remain active
    expect(topicAAttrs.status).toBe('active')

    // topicB has lower mentionCount, should be merged
    expect(topicBAttrs.status).toBe('merged')
    expect(topicBAttrs.mergedInto).toBe(topicAId)
  })

  test('merge-similar preserves higher-mentionCount topic as canonical', async () => {
    const context = engine.createDomainContext(TOPIC_DOMAIN_ID)

    const topicAId = await context.writeMemory({
      content: 'React framework for building UIs',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'React',
          status: 'active',
          mentionCount: 5,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    const topicBId = await context.writeMemory({
      content: 'React framework for building UIs',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'React duplicate',
          status: 'active',
          mentionCount: 2,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    await mergeSimilarTopics(context)

    const searchResult = await context.search({ text: 'React framework for building UIs', tags: [TOPIC_TAG] })
    const entries = searchResult.entries

    const topicA = entries.find(e => e.id === topicAId)
    const topicB = entries.find(e => e.id === topicBId)

    expect(topicA).toBeDefined()
    expect(topicB).toBeDefined()

    const topicAAttrs = topicA!.domainAttributes[TOPIC_DOMAIN_ID]
    const topicBAttrs = topicB!.domainAttributes[TOPIC_DOMAIN_ID]

    // topicA (mentionCount=5) remains active
    expect(topicAAttrs.status).toBe('active')
    // canonical gets merged topic's mentionCount added
    expect(topicAAttrs.mentionCount).toBe(7)

    // topicB (mentionCount=2) is merged into topicA
    expect(topicBAttrs.status).toBe('merged')
    expect(topicBAttrs.mergedInto).toBe(topicAId)
  })

  test('merge-similar skips topics below similarity threshold', async () => {
    const context = engine.createDomainContext(TOPIC_DOMAIN_ID)

    await context.writeMemory({
      content: 'quantum mechanics wave function collapse observation',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'Quantum Mechanics',
          status: 'active',
          mentionCount: 3,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    await context.writeMemory({
      content: 'medieval castle architecture buttress flying gothic cathedral',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'Medieval Architecture',
          status: 'active',
          mentionCount: 2,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    await mergeSimilarTopics(context)

    const searchResult = await context.search({ text: 'quantum mechanics medieval architecture' })
    const entries = searchResult.entries

    // Both should remain active since they are dissimilar
    for (const entry of entries) {
      const attrs = entry.domainAttributes[TOPIC_DOMAIN_ID]
      expect(attrs.status).toBe('active')
      expect(attrs.mergedInto).toBeUndefined()
    }
  })
})

describe('Topic domain - config', () => {
  test('topic domain registers with correct baseDir and skills', () => {
    const domain = createTopicDomain()
    expect(domain.id).toBe(TOPIC_DOMAIN_ID)
    expect(domain.name).toBe('Topic')
    expect(domain.baseDir).toBeTypeOf('string')
    expect(domain.baseDir!.length).toBeGreaterThan(0)
    expect(domain.skills).toHaveLength(3)
    const skillIds = domain.skills!.map(s => s.id)
    expect(skillIds).toContain('topic-management')
    expect(skillIds).toContain('topic-query')
    expect(skillIds).toContain('topic-processing')
  })

  test('topic domain schema has 3 edges (subtopic_of, related_to, about_topic)', () => {
    const domain = createTopicDomain()
    const edges = domain.schema!.edges
    expect(edges).toHaveLength(3)

    const edgeNames = edges.map(e => e.name)
    expect(edgeNames).toContain('subtopic_of')
    expect(edgeNames).toContain('related_to')
    expect(edgeNames).toContain('about_topic')

    const relatedTo = edges.find(e => e.name === 'related_to')!
    expect(relatedTo.fields).toEqual([{ name: 'strength', type: 'float' }])

    const aboutTopic = edges.find(e => e.name === 'about_topic')!
    expect(aboutTopic.fields).toEqual([{ name: 'domain', type: 'string' }])

    const subtopicOf = edges.find(e => e.name === 'subtopic_of')!
    expect(subtopicOf.fields).toBeUndefined()
  })

  test('topic domain describe() returns a non-empty string', () => {
    const domain = createTopicDomain()
    const describeFn = domain.describe?.bind(domain)
    expect(describeFn).toBeTypeOf('function')
    const description = describeFn!()
    expect(description).toBeTypeOf('string')
    expect(description.length).toBeGreaterThan(0)
  })

  test('createTopicDomain() with default options includes merge schedule', () => {
    const domain = createTopicDomain()
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].id).toBe('merge-similar-topics')
    expect(domain.schedules![0].intervalMs).toBe(DEFAULT_MERGE_INTERVAL_MS)
  })

  test('createTopicDomain({ mergeSchedule: { enabled: false } }) has no schedules', () => {
    const domain = createTopicDomain({ mergeSchedule: { enabled: false } })
    expect(domain.schedules).toHaveLength(0)
  })

  test('createTopicDomain({ mergeSchedule: { intervalMs: 5000 } }) uses custom interval', () => {
    const domain = createTopicDomain({ mergeSchedule: { intervalMs: 5000 } })
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].intervalMs).toBe(5000)
  })

  test('processInboxItem is a no-op (does not throw, returns void)', async () => {
    const domain = createTopicDomain()
    const result = await domain.processInboxItem(
      { memory: { id: 'test', content: '', embedding: [], eventTime: null, createdAt: 0, tokenCount: 0 }, domainAttributes: {}, tags: [] },
      {} as DomainContext
    )
    expect(result).toBeUndefined()
  })

  test('default topicDomain instance is a valid DomainConfig', () => {
    expect(topicDomain.id).toBe(TOPIC_DOMAIN_ID)
    expect(topicDomain.schedules).toHaveLength(1)
  })
})

describe('Topic domain - integration', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(topicDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('creating a topic via writeMemory with topic attributes', async () => {
    const context = engine.createDomainContext(TOPIC_DOMAIN_ID)

    const topicId = await context.writeMemory({
      content: 'Machine learning and AI applications',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'Machine Learning',
          status: 'active',
          mentionCount: 0,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    expect(topicId).toBeTruthy()

    const memory = await context.getMemory(topicId)
    expect(memory).toBeDefined()
    expect(memory!.id).toBe(topicId)
    expect(memory!.content).toBe('Machine learning and AI applications')

    const searchResult = await context.search({
      text: 'Machine learning and AI applications',
      tags: [TOPIC_TAG],
    })

    const found = searchResult.entries.find(e => e.id === topicId)
    expect(found).toBeDefined()
    expect(found!.domainAttributes[TOPIC_DOMAIN_ID]).toBeDefined()
    expect(found!.domainAttributes[TOPIC_DOMAIN_ID].name).toBe('Machine Learning')
    expect(found!.domainAttributes[TOPIC_DOMAIN_ID].status).toBe('active')
  })

  test('linking a memory to a topic via about_topic edge', async () => {
    const topicContext = engine.createDomainContext(TOPIC_DOMAIN_ID)

    const topicId = await topicContext.writeMemory({
      content: 'TypeScript language features',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'TypeScript',
          status: 'active',
          mentionCount: 0,
          lastMentionedAt: Date.now(),
          createdBy: 'test',
        },
      },
    })

    const notesDomain: DomainConfig = {
      id: 'notes',
      name: 'Notes',
      schema: { nodes: [], edges: [] },
      async processInboxItem(_entry: OwnedMemory, _context: DomainContext) {},
    }
    await engine.registerDomain(notesDomain)

    const ingestResult = await engine.ingest(
      'TypeScript supports generics and interfaces for strong typing',
      { domains: ['notes'] }
    )
    expect(ingestResult.action).toBe('stored')
    const memId = ingestResult.id!

    await topicContext.graph.relate(memId, 'about_topic', topicId, { domain: 'notes' })

    const linked = await topicContext.graph.traverse(memId, '->about_topic->memory')
    expect(linked.length).toBeGreaterThan(0)
    const linkedIds = linked.map(n => String((n as { id: string }).id))
    const normalizedTopicId = topicId.startsWith('memory:') ? topicId.slice('memory:'.length) : topicId
    expect(linkedIds.some(id => id === topicId || id === normalizedTopicId)).toBe(true)
  })

  test('subtopic_of creates parent-child relationship', async () => {
    const context = engine.createDomainContext(TOPIC_DOMAIN_ID)
    const now = Date.now()

    const parentId = await context.writeMemory({
      content: 'Programming Languages overview',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'Programming Languages',
          status: 'active',
          mentionCount: 0,
          lastMentionedAt: now,
          createdBy: 'test',
        },
      },
    })

    const childId = await context.writeMemory({
      content: 'TypeScript typed superset of JavaScript',
      tags: [TOPIC_TAG],
      ownership: {
        domain: TOPIC_DOMAIN_ID,
        attributes: {
          name: 'TypeScript',
          status: 'active',
          mentionCount: 0,
          lastMentionedAt: now,
          createdBy: 'test',
        },
      },
    })

    await context.graph.relate(childId, 'subtopic_of', parentId)

    const parents = await context.graph.traverse(childId, '->subtopic_of->memory')
    expect(parents.length).toBeGreaterThan(0)
    const parentIds = parents.map(n => String((n as { id: string }).id))
    const normalizedParentId = parentId.startsWith('memory:') ? parentId.slice('memory:'.length) : parentId
    expect(parentIds.some(id => id === parentId || id === normalizedParentId)).toBe(true)
  })
})
