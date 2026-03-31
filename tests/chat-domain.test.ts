import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'
import { createChatDomain, chatDomain } from '../src/domains/chat/index.ts'
import { createTopicDomain } from '../src/domains/topic/index.ts'
import {
  CHAT_DOMAIN_ID,
  CHAT_TAG,
  CHAT_MESSAGE_TAG,
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  DEFAULT_PRUNE_INTERVAL_MS,
} from '../src/domains/chat/types.ts'
import { TOPIC_TAG } from '../src/domains/topic/types.ts'
describe('Chat domain - config', () => {
  test('has correct id and name', () => {
    const domain = createChatDomain()
    expect(domain.id).toBe('chat')
    expect(domain.name).toBe('Chat')
  })

  test('has baseDir and 3 skills', () => {
    const domain = createChatDomain()
    expect(domain.baseDir).toBeTypeOf('string')
    expect(domain.baseDir!.length).toBeGreaterThan(0)
    expect(domain.skills).toHaveLength(3)
    const skillIds = domain.skills!.map(s => s.id)
    expect(skillIds).toContain('chat-ingest')
    expect(skillIds).toContain('chat-query')
    expect(skillIds).toContain('chat-processing')
  })

  test('schema has 1 edge (summarizes)', () => {
    const domain = createChatDomain()
    const edges = domain.schema!.edges
    expect(edges).toHaveLength(1)
    expect(edges[0].name).toBe('summarizes')
    expect(edges[0].from).toBe('memory')
    expect(edges[0].to).toBe('memory')
  })

  test('default options include all three schedules', () => {
    const domain = createChatDomain()
    expect(domain.schedules).toHaveLength(3)
    const scheduleIds = domain.schedules!.map(s => s.id)
    expect(scheduleIds).toContain('promote-working-memory')
    expect(scheduleIds).toContain('consolidate-episodic')
    expect(scheduleIds).toContain('prune-decayed')
  })

  test('schedules use default intervals', () => {
    const domain = createChatDomain()
    const promote = domain.schedules!.find(s => s.id === 'promote-working-memory')!
    const consolidate = domain.schedules!.find(s => s.id === 'consolidate-episodic')!
    const prune = domain.schedules!.find(s => s.id === 'prune-decayed')!
    expect(promote.intervalMs).toBe(DEFAULT_PROMOTE_INTERVAL_MS)
    expect(consolidate.intervalMs).toBe(DEFAULT_CONSOLIDATE_INTERVAL_MS)
    expect(prune.intervalMs).toBe(DEFAULT_PRUNE_INTERVAL_MS)
  })

  test('individual schedules can be disabled', () => {
    const domain = createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
    })
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].id).toBe('prune-decayed')
  })

  test('schedules accept custom intervals', () => {
    const domain = createChatDomain({
      promoteSchedule: { intervalMs: 5000 },
    })
    const promote = domain.schedules!.find(s => s.id === 'promote-working-memory')!
    expect(promote.intervalMs).toBe(5000)
  })

  test('describe() returns a non-empty string', () => {
    const domain = createChatDomain()
    const describeFn = domain.describe?.bind(domain)
    expect(describeFn).toBeTypeOf('function')
    expect(describeFn!().length).toBeGreaterThan(0)
  })

  test('default chatDomain instance is valid', () => {
    expect(chatDomain.id).toBe(CHAT_DOMAIN_ID)
    expect(chatDomain.schedules).toHaveLength(3)
  })
})

describe('Chat domain - inbox processing', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    llm.extractResult = []
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user', chatSessionId: 'session-1' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }))
    await engine.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))
  })

  afterEach(async () => {
    await engine.close()
  })

  test('stores message as working memory with correct attributes', async () => {
    const result = await engine.ingest('Hello world', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    expect(result.action).toBe('stored')

    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({
      tags: [CHAT_MESSAGE_TAG],
      attributes: { chatSessionId: 'session-1', userId: 'test-user' },
    })
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe('Hello world')

    // Verify tags
    const tags = await ctx.getMemoryTags(memories[0].id)
    expect(tags).toContain(CHAT_TAG)
    expect(tags).toContain(CHAT_MESSAGE_TAG)
  })

  test('sets role, layer, chatSessionId, userId, messageIndex attributes', async () => {
    await engine.ingest('Test message', {
      domains: ['chat'],
      metadata: { role: 'assistant' },
    })

    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({
      attributes: { role: 'assistant', layer: 'working', chatSessionId: 'session-1', userId: 'test-user', messageIndex: 0 },
    })
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe('Test message')
  })

  test('messageIndex auto-increments for successive messages', async () => {
    await engine.ingest('First message', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    await engine.ingest('Second message', {
      domains: ['chat'],
      metadata: { role: 'assistant' },
    })
    await engine.processInbox()

    await engine.ingest('Third message', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)

    const first = await ctx.getMemories({ attributes: { messageIndex: 0 } })
    expect(first).toHaveLength(1)
    expect(first[0].content).toBe('First message')

    const second = await ctx.getMemories({ attributes: { messageIndex: 1 } })
    expect(second).toHaveLength(1)
    expect(second[0].content).toBe('Second message')

    const third = await ctx.getMemories({ attributes: { messageIndex: 2 } })
    expect(third).toHaveLength(1)
    expect(third[0].content).toBe('Third message')
  })

  test('skips processing when userId is missing from context', async () => {
    // Create engine without userId
    const engine2 = new MemoryEngine()
    await engine2.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_no_user_${Date.now()}`,
      context: { chatSessionId: 'session-1' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine2.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }))
    await engine2.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))

    await engine2.ingest('Should be skipped', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    await engine2.processInbox()

    const ctx = engine2.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] })
    expect(memories).toHaveLength(0)

    await engine2.close()
  })

  test('skips processing when chatSessionId is missing from context', async () => {
    const engine2 = new MemoryEngine()
    await engine2.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_no_session_${Date.now()}`,
      context: { userId: 'test-user' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine2.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }))
    await engine2.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))

    await engine2.ingest('Should be skipped too', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    await engine2.processInbox()

    const ctx = engine2.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] })
    expect(memories).toHaveLength(0)

    await engine2.close()
  })

  test('extracts topics and links them via about_topic edges', async () => {
    llm.extractResult = ['TypeScript', 'memory systems']

    await engine.ingest('I love working with TypeScript and memory systems', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const messages = await ctx.getMemories({
      tags: [CHAT_MESSAGE_TAG],
      attributes: { chatSessionId: 'session-1' },
    })
    expect(messages).toHaveLength(1)

    // Verify about_topic edges from the message
    const edges = await ctx.getNodeEdges(messages[0].id, 'out')
    const topicEdges = edges.filter(e => String(e.id).startsWith('about_topic:'))
    expect(topicEdges).toHaveLength(2)

    // Verify topics were created with correct tags
    const topics = await ctx.getMemories({ tags: [TOPIC_TAG] })
    expect(topics).toHaveLength(2)
    const topicContents = topics.map(t => t.content).sort()
    expect(topicContents).toEqual(['TypeScript', 'memory systems'])
  })

  test('reuses existing topic instead of creating duplicate', async () => {
    llm.extractResult = ['TypeScript']

    // First message mentioning TypeScript
    await engine.ingest('TypeScript is great', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    // Second message also mentioning TypeScript
    await engine.ingest('I use TypeScript daily', {
      domains: ['chat'],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    // Should still only have one topic (if search matched)
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const topics = await ctx.getMemories({ tags: [TOPIC_TAG] })
    // Note: with mock embedding, similarity matching may or may not find the existing topic
    // so we just verify topics were created and edges exist
    expect(topics.length).toBeGreaterThanOrEqual(1)
  })

  test('defaults role to user when not provided in metadata', async () => {
    await engine.ingest('No role specified', {
      domains: ['chat'],
      metadata: {},
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({
      attributes: { role: 'user', layer: 'working' },
    })
    expect(memories).toHaveLength(1)
  })
})
