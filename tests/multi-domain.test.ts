import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'
import type { DomainConfig, OwnedMemory, DomainContext, SharedSchema } from '../src/core/types.ts'

const testSharedSchema: SharedSchema = {
  nodes: [
    {
      name: 'entity',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'labels', type: 'array<string>', required: false },
        { name: 'first_seen', type: 'int', required: false },
      ],
    },
    {
      name: 'category',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'kind', type: 'string', required: false },
      ],
      indexes: [{ name: 'idx_category_name', fields: ['name'], type: 'unique' }],
    },
    {
      name: 'topic',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'status', type: 'string', required: false, default: 'active' },
      ],
    },
  ],
  edges: [
    { name: 'belongs_to', from: ['entity'], to: 'category' },
  ],
}

describe('Multi-domain integration', () => {
  let engine: MemoryEngine

  const alphaDomain: DomainConfig = {
    id: 'alpha',
    name: 'Alpha Analysis',
    schema: {
      nodes: [],
      edges: [
        { name: 'about', from: 'memory', to: 'topic', fields: [{ name: 'relevance', type: 'float' }] },
        { name: 'mentions', from: 'memory', to: 'entity', fields: [{ name: 'role_in_context', type: 'string' }] },
      ],
    },
    async processInboxItem(entry: OwnedMemory, ctx: DomainContext) {
      if (entry.memory.content.includes('alpha')) {
        const topicId = await ctx.graph.createNodeWithId('topic:alpha_topic', {
          name: 'Alpha Topic',
          status: 'active',
        }).catch(() => 'topic:alpha_topic')
        await ctx.graph.relate(entry.memory.id, 'about', topicId, { relevance: 0.9 })
      }
    },
  }

  const betaDomain: DomainConfig = {
    id: 'beta',
    name: 'Beta Analysis',
    schema: {
      nodes: [
        { name: 'resource', fields: [{ name: 'name', type: 'string' }, { name: 'kind', type: 'string' }] },
      ],
      edges: [
        { name: 'impacts', from: 'memory', to: 'resource', fields: [{ name: 'direction', type: 'string' }] },
      ],
    },
    async processInboxItem(entry: OwnedMemory, ctx: DomainContext) {
      if (entry.memory.content.includes('beta')) {
        const resourceId = await ctx.graph.createNodeWithId('resource:beta_resource', {
          name: 'Beta Resource',
          kind: 'abstract',
        }).catch(() => 'resource:beta_resource')
        await ctx.graph.relate(entry.memory.id, 'impacts', resourceId, { direction: 'positive' })
      }
    },
  }

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      sharedSchemas: [testSharedSchema],
    })
    await engine.registerDomain(alphaDomain)
    await engine.registerDomain(betaDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('shared schema allows creating shared node types', async () => {
    const graph = engine.getGraph()
    const categoryId = await graph.createNodeWithId('category:testing', { name: 'Testing', kind: 'group' })
    expect(categoryId).toBe('category:testing')

    const category = await graph.getNode('category:testing')
    expect(category!.name).toBe('Testing')
  })

  test('multiple domains process the same memory', async () => {
    const result = await engine.ingest('alpha and beta content together', {
      domains: ['alpha', 'beta'],
    })

    // Process inbox — processNext handles one memory through all its owning domains
    await engine.processInbox()

    const graph = engine.getGraph()

    // Alpha domain should have created topic and linked it
    const topics = await graph.traverse(result.id!, '->about->topic')
    expect(topics.length).toBe(1)

    // Beta domain should have created resource and linked it
    const resources = await graph.traverse(result.id!, '->impacts->resource')
    expect(resources.length).toBe(1)
  })

  test('shared entity node is accessible to both domains', async () => {
    const graph = engine.getGraph()

    await graph.createNodeWithId('entity:sample', {
      name: 'Sample Entity',
      labels: ['test'],
      first_seen: Date.now(),
    })

    const entity = await graph.getNode('entity:sample')
    expect(entity!.name).toBe('Sample Entity')

    await graph.createNodeWithId('category:testing', { name: 'Testing', kind: 'group' })
    await graph.relate('entity:sample', 'belongs_to', 'category:testing')

    const categoryIds = await graph.traverse<string>('entity:sample', '->belongs_to->category')
    expect(categoryIds.length).toBe(1)

    const linkedCategory = await graph.getNode(String(categoryIds[0]))
    expect(linkedCategory!.name).toBe('Testing')
  })

  test('domain schema extension does not conflict', async () => {
    expect(engine.getDomainRegistry().has('alpha')).toBe(true)
    expect(engine.getDomainRegistry().has('beta')).toBe(true)
  })

  test('search across domains', async () => {
    await engine.ingest('alpha domain content only', { domains: ['alpha'] })
    await engine.ingest('beta domain content only', { domains: ['beta'] })

    const result = await engine.search({
      mode: 'graph',
      domains: ['alpha', 'beta'],
      limit: 10,
    })
    expect(result.entries.length).toBe(2)

    const alphaOnly = await engine.search({
      mode: 'graph',
      domains: ['alpha'],
      limit: 10,
    })
    expect(alphaOnly.entries.length).toBe(1)
    expect(alphaOnly.entries[0].content).toContain('alpha')
  })
})
