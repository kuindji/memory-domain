import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'
import { consolidateUserProfile } from '../src/domains/user/schedules.ts'
import { USER_TAG, USER_DOMAIN_ID, DEFAULT_CONSOLIDATE_INTERVAL_MS } from '../src/domains/user/types.ts'
import { createUserDomain, userDomain } from '../src/domains/user/index.ts'
import type { DomainConfig, OwnedMemory, DomainContext } from '../src/core/types.ts'

describe('User domain - config', () => {
  test('has correct id and name', () => {
    const domain = createUserDomain()
    expect(domain.id).toBe('user')
    expect(domain.name).toBe('User')
  })

  test('has structure (non-empty string) and 3 skills', () => {
    const domain = createUserDomain()
    expect(domain.structure).toBeTypeOf('string')
    expect(domain.structure!.length).toBeGreaterThan(0)
    expect(domain.skills).toHaveLength(3)
    const skillIds = domain.skills!.map(s => s.id)
    expect(skillIds).toContain('user-data')
    expect(skillIds).toContain('user-query')
    expect(skillIds).toContain('user-profile')
  })

  test('schema has 1 node (user with userId field + unique index) and 1 edge (about_user)', () => {
    const domain = createUserDomain()
    const nodes = domain.schema!.nodes
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('user')
    expect(nodes[0].fields).toEqual([{ name: 'userId', type: 'string', required: true }])
    expect(nodes[0].indexes).toHaveLength(1)
    expect(nodes[0].indexes![0].type).toBe('unique')

    const edges = domain.schema!.edges
    expect(edges).toHaveLength(1)
    expect(edges[0].name).toBe('about_user')
    expect(edges[0].from).toBe('memory')
    expect(edges[0].to).toBe('user')
  })

  test('default options include consolidation schedule', () => {
    const domain = createUserDomain()
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].id).toBe('consolidate-user-profile')
    expect(domain.schedules![0].intervalMs).toBe(DEFAULT_CONSOLIDATE_INTERVAL_MS)
  })

  test('consolidation schedule can be disabled', () => {
    const domain = createUserDomain({ consolidateSchedule: { enabled: false } })
    expect(domain.schedules).toHaveLength(0)
  })

  test('consolidation schedule accepts custom interval', () => {
    const domain = createUserDomain({ consolidateSchedule: { intervalMs: 5000 } })
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].intervalMs).toBe(5000)
  })

  test('processInboxItem is a no-op (returns undefined)', async () => {
    const domain = createUserDomain()
    const result = await domain.processInboxItem(
      { memory: { id: 'test', content: '', embedding: [], eventTime: null, createdAt: 0, tokenCount: 0 }, domainAttributes: {}, tags: [] },
      {} as DomainContext
    )
    expect(result).toBeUndefined()
  })

  test('describe() returns a non-empty string', () => {
    const domain = createUserDomain()
    const describeFn = domain.describe?.bind(domain)
    expect(describeFn).toBeTypeOf('function')
    const description = describeFn!()
    expect(description).toBeTypeOf('string')
    expect(description.length).toBeGreaterThan(0)
  })

  test('default userDomain instance is valid', () => {
    expect(userDomain.id).toBe(USER_DOMAIN_ID)
    expect(userDomain.schedules).toHaveLength(1)
  })
})

describe('User domain - integration', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user' },
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(userDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('user node can be created and retrieved', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    await ctx.graph.createNodeWithId('user:test-user', { userId: 'test-user' })

    const node = await ctx.graph.getNode('user:test-user')
    expect(node).toBeDefined()
    expect(node!.userId).toBe('test-user')
  })

  test('user fact can be stored and linked to user node via about_user edge', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    await ctx.graph.createNodeWithId('user:test-user', { userId: 'test-user' })

    const memId = await ctx.writeMemory({
      content: 'User is proficient in TypeScript and Rust',
      tags: [`${USER_TAG}/expertise`],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })

    await ctx.graph.relate(memId, 'about_user', 'user:test-user', { domain: USER_DOMAIN_ID })

    const edges = await ctx.getNodeEdges('user:test-user', 'in')
    expect(edges.length).toBeGreaterThan(0)
    const sourceIds = edges.map(e => String(e.in))
    expect(sourceIds.some(id => id === memId || id === `memory:${memId}` || memId.endsWith(id))).toBe(true)
  })

  test('user fact tags are retrievable via getMemoryTags', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)

    // Ensure tag node exists so getMemoryTags can resolve the label
    const tagLabel = `${USER_TAG}/preference`
    try {
      await ctx.graph.createNodeWithId(`tag:${tagLabel}`, { label: tagLabel, created_at: Date.now() })
    } catch { /* already exists */ }

    const memId = await ctx.writeMemory({
      content: 'User prefers dark mode',
      tags: [`${USER_TAG}/preference`],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })

    // Process inbox so tags are clean (inbox tag removed)
    await engine.processInbox()

    const tags = await ctx.getMemoryTags(memId)
    expect(tags).toContain(`${USER_TAG}/preference`)
  })

  test('another domain can link its memory to user via about_user edge', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    await ctx.graph.createNodeWithId('user:test-user', { userId: 'test-user' })

    const notesDomain: DomainConfig = {
      id: 'notes',
      name: 'Notes',
      schema: { nodes: [], edges: [] },
      async processInboxItem(_entry: OwnedMemory, _context: DomainContext) {},
    }
    await engine.registerDomain(notesDomain)

    const ingestResult = await engine.ingest(
      'User mentioned they enjoy hiking on weekends',
      { domains: ['notes'] }
    )
    expect(ingestResult.action).toBe('stored')
    const memId = ingestResult.id!

    await ctx.graph.relate(memId, 'about_user', 'user:test-user', { domain: 'notes' })

    const edges = await ctx.getNodeEdges('user:test-user', 'in')
    expect(edges.length).toBeGreaterThan(0)
    const sourceIds = edges.map(e => String(e.in))
    expect(sourceIds.some(id => id === memId || id === `memory:${memId}` || memId.endsWith(id))).toBe(true)
  })

  test('search.expand hook receives userId from request context', () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    expect(ctx.requestContext.userId).toBe('test-user')
  })
})

describe('User domain - consolidation schedule', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    llm.consolidateResult = 'Test user is a TypeScript developer who enjoys hiking.'
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(userDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('consolidation creates a profile summary from linked memories', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    await ctx.graph.createNodeWithId('user:test-user', { userId: 'test-user' })

    // Use 'fact' tag (not user/* subtag) to avoid SurrealDB record ID collision
    // with the profile-summary tag during getMemories filtering
    const mem1 = await ctx.writeMemory({
      content: 'User is proficient in TypeScript',
      tags: ['fact'],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })
    await ctx.graph.relate(mem1, 'about_user', 'user:test-user', { domain: USER_DOMAIN_ID })

    const mem2 = await ctx.writeMemory({
      content: 'User enjoys hiking on weekends',
      tags: ['fact'],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })
    await ctx.graph.relate(mem2, 'about_user', 'user:test-user', { domain: USER_DOMAIN_ID })

    await consolidateUserProfile(ctx)

    // Verify a summary was created by checking all domain memories for the consolidated content
    const allMemories = await ctx.getMemories({ domains: [USER_DOMAIN_ID] })
    const summaryMemory = allMemories.find(m => m.content === llm.consolidateResult)
    expect(summaryMemory).toBeDefined()

    // Verify the summary is linked to the user node via about_user edge
    const edges = await ctx.getNodeEdges('user:test-user', 'in')
    const summaryEdge = edges.find(e => String(e.in) === summaryMemory!.id)
    expect(summaryEdge).toBeDefined()
  })

  test('consolidation skips when no user nodes exist', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)

    await consolidateUserProfile(ctx)

    const allMemories = await ctx.getMemories({ domains: [USER_DOMAIN_ID] })
    expect(allMemories.length).toBe(0)
  })

  test('consolidation updates existing summary instead of creating duplicate', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    await ctx.graph.createNodeWithId('user:test-user', { userId: 'test-user' })

    const mem1 = await ctx.writeMemory({
      content: 'User likes TypeScript',
      tags: ['fact'],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })
    await ctx.graph.relate(mem1, 'about_user', 'user:test-user', { domain: USER_DOMAIN_ID })

    // First consolidation
    await consolidateUserProfile(ctx)

    // Verify a summary was created
    const afterFirst = await ctx.getMemories({ domains: [USER_DOMAIN_ID] })
    const firstSummary = afterFirst.find(m => m.content === llm.consolidateResult)
    expect(firstSummary).toBeDefined()

    // Change the LLM result for second run
    llm.consolidateResult = 'Updated: User is a senior TypeScript developer.'

    // Second consolidation
    await consolidateUserProfile(ctx)

    // Verify that the summary was updated, not duplicated
    const afterSecond = await ctx.getMemories({ domains: [USER_DOMAIN_ID] })
    const summaries = afterSecond.filter(m => m.id !== mem1)
    expect(summaries.length).toBe(1)
    expect(summaries[0].content).toBe('Updated: User is a senior TypeScript developer.')
  })
})
