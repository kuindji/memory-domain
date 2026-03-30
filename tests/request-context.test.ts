import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'
import type { DomainConfig, RequestContext } from '../src/core/types.ts'

describe('Request context', () => {
  let engine: MemoryEngine

  afterEach(async () => {
    await engine.close()
  })

  test('engine default context is available on DomainContext', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      context: { userId: 'user-1' },
    })
    const ctx = engine.createDomainContext('log')
    expect(ctx.requestContext).toEqual({ userId: 'user-1' })
  })

  test('per-request context overrides engine default', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      context: { userId: 'default-user', lang: 'en' },
    })
    const ctx = engine.createDomainContext('log', { userId: 'override-user' })
    expect(ctx.requestContext).toEqual({ userId: 'override-user', lang: 'en' })
  })

  test('empty engine context with per-request context', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
    const ctx = engine.createDomainContext('log', { userId: 'user-1' })
    expect(ctx.requestContext).toEqual({ userId: 'user-1' })
  })

  test('no context at all results in empty object', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
    const ctx = engine.createDomainContext('log')
    expect(ctx.requestContext).toEqual({})
  })

  test('search expand hook receives request context', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
      context: { userId: 'user-1' },
    })

    let capturedContext: RequestContext | undefined
    const testDomain: DomainConfig = {
      id: 'ctx-test',
      name: 'Context Test',
      async processInboxItem() {},
      search: {
        expand(query, context) {
          capturedContext = context.requestContext
          return Promise.resolve(query)
        },
      },
    }
    await engine.registerDomain(testDomain)
    await engine.search({ text: 'hello', domains: ['ctx-test'], context: { userId: 'per-request' } })
    expect(capturedContext).toEqual({ userId: 'per-request' })
  })
})

describe('getMemoryTags', () => {
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
  })

  afterEach(async () => {
    await engine.close()
  })

  test('returns tags for a memory', async () => {
    const result = await engine.ingest('tagged memory', { tags: ['alpha', 'beta'] })
    await engine.processInbox()
    const ctx = engine.createDomainContext('log')
    const tags = await ctx.getMemoryTags(result.id!)
    expect(tags).toContain('alpha')
    expect(tags).toContain('beta')
    expect(tags).not.toContain('inbox')
  })

  test('returns empty array for memory with no tags', async () => {
    const ctx = engine.createDomainContext('log')
    const result = await engine.ingest('plain memory')
    await engine.processInbox()
    const tags = await ctx.getMemoryTags(result.id!)
    expect(tags).toEqual([])
  })
})

describe('getNodeEdges', () => {
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
  })

  afterEach(async () => {
    await engine.close()
  })

  test('returns outgoing edges for a node', async () => {
    const result = await engine.ingest('test memory', { tags: ['test-tag'] })
    const ctx = engine.createDomainContext('log')
    const edges = await ctx.getNodeEdges(result.id!, 'out')
    expect(edges.length).toBeGreaterThan(0)
  })

  test('returns edges in both directions by default', async () => {
    const result = await engine.ingest('test memory')
    const ctx = engine.createDomainContext('log')
    const edges = await ctx.getNodeEdges(result.id!)
    expect(edges.length).toBeGreaterThan(0)
  })
})
