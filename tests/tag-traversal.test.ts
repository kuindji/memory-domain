import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'
import type { DomainContext } from '../src/core/types.ts'

describe('getTagDescendants', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  test('returns all descendants in a 3-level hierarchy', async () => {
    const ctx = (engine as { createDomainContext: (id: string) => DomainContext }).createDomainContext('log')
    await ctx.addTag('region/asia/east_asia')

    const descendants = await ctx.getTagDescendants('region')

    expect(descendants).toHaveLength(2)
    expect(descendants).toContain('tag:asia')
    expect(descendants).toContain('tag:east_asia')
  })

  test('returns empty array for a leaf tag with no children', async () => {
    const ctx = (engine as { createDomainContext: (id: string) => DomainContext }).createDomainContext('log')
    await ctx.addTag('standalone')

    const descendants = await ctx.getTagDescendants('standalone')

    expect(descendants).toEqual([])
  })
})
