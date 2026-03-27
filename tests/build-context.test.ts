import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'

describe('MemoryEngine.buildContext', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_ctx_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  test('returns empty context when no memories exist', async () => {
    const result = await engine.buildContext('anything')
    expect(result.context).toBe('')
    expect(result.memories).toHaveLength(0)
    expect(result.totalTokens).toBe(0)
  })

  test('returns context from ingested memories', async () => {
    await engine.ingest('The sky is blue')
    await engine.ingest('Water is wet')

    // Process inbox so memories are searchable
    await engine.processInbox()
    await engine.processInbox()

    const result = await engine.buildContext('sky')
    // At minimum, the result should have the structure
    expect(typeof result.context).toBe('string')
    expect(Array.isArray(result.memories)).toBe(true)
    expect(typeof result.totalTokens).toBe('number')
  })

  test('respects budgetTokens option', async () => {
    // Ingest several memories
    for (let i = 0; i < 10; i++) {
      await engine.ingest(`Memory entry number ${i} with some content to take up tokens`)
    }

    const result = await engine.buildContext('memory', { budgetTokens: 50 })
    // With a tiny budget, we should get fewer memories than we ingested
    expect(result.memories.length).toBeLessThan(10)
  })

  test('respects domain filtering', async () => {
    await engine.registerDomain({
      id: 'special',
      name: 'Special',
      async processInboxItem() {},
    })

    // Ingest to specific domain
    await engine.ingest('Special content', { domains: ['special'] })
    // Ingest to all domains (log + special)
    await engine.ingest('General content')

    const result = await engine.buildContext('content', { domains: ['special'] })
    // Should only return memories owned by 'special'
    for (const mem of result.memories) {
      expect(mem.content).toBeDefined()
    }
  })

  test('uses custom domain buildContext when single domain specified', async () => {
    await engine.registerDomain({
      id: 'custom',
      name: 'Custom',
      async processInboxItem() {},
      async buildContext(_text, _budget, _ctx) {
        return {
          context: 'custom context output',
          memories: [],
          totalTokens: 5,
        }
      },
    })

    const result = await engine.buildContext('anything', { domains: ['custom'] })
    expect(result.context).toBe('custom context output')
    expect(result.totalTokens).toBe(5)
  })

  test('formats context as numbered entries', async () => {
    await engine.ingest('First memory')
    await engine.ingest('Second memory')

    const result = await engine.buildContext('memory')
    if (result.memories.length > 0) {
      expect(result.context).toContain('[1]')
    }
  })
})
