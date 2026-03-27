import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { InboxProcessor } from '../src/core/inbox-processor.ts'
import { GraphStore } from '../src/core/graph-store.ts'
import { SchemaRegistry } from '../src/core/schema-registry.ts'
import { DomainRegistry } from '../src/core/domain-registry.ts'
import { EventEmitter } from '../src/core/events.ts'
import { createTestDb, MockLLMAdapter } from './helpers.ts'
import type { Surreal } from 'surrealdb'
import type { DomainConfig, OwnedMemory, DomainContext } from '../src/core/types.ts'

describe('InboxProcessor', () => {
  let db: Surreal
  let store: GraphStore
  let domainRegistry: DomainRegistry
  let events: EventEmitter
  let processor: InboxProcessor
  const processedItems: OwnedMemory[] = []

  const testDomain: DomainConfig = {
    id: 'test',
    name: 'Test Domain',
    async processInboxItem(entry: OwnedMemory, _ctx: DomainContext) {
      processedItems.push(entry)
    },
  }

  beforeEach(async () => {
    processedItems.length = 0
    db = await createTestDb()
    const schema = new SchemaRegistry(db)
    await schema.registerCore()
    store = new GraphStore(db)
    domainRegistry = new DomainRegistry()
    domainRegistry.register(testDomain)
    events = new EventEmitter()
    processor = new InboxProcessor(store, domainRegistry, events, (domainId: string) => ({
      domain: domainId,
      graph: store,
      llm: new MockLLMAdapter(),
    } as unknown as DomainContext))
  })

  afterEach(async () => {
    await db.close()
  })

  test('processNext picks up inbox-tagged memory', async () => {
    const memId = await store.createNode('memory', {
      content: 'test content',
      created_at: Date.now(),
      token_count: 5,
    })
    await store.createNodeWithId('tag:inbox', { label: 'inbox', created_at: Date.now() })
    await store.relate(memId, 'tagged', 'tag:inbox')
    await store.createNodeWithId('domain:test', { name: 'Test Domain' })
    await store.relate(memId, 'owned_by', 'domain:test', { attributes: {}, owned_at: Date.now() })

    const processed = await processor.processNext()
    expect(processed).toBe(true)
    expect(processedItems.length).toBe(1)
    expect(processedItems[0].memory.content).toBe('test content')
  })

  test('processNext returns false when no inbox items', async () => {
    const processed = await processor.processNext()
    expect(processed).toBe(false)
  })

  test('processNext removes inbox tag after processing', async () => {
    const memId = await store.createNode('memory', {
      content: 'test content',
      created_at: Date.now(),
      token_count: 5,
    })
    await store.createNodeWithId('tag:inbox', { label: 'inbox', created_at: Date.now() })
    await store.relate(memId, 'tagged', 'tag:inbox')
    await store.createNodeWithId('domain:test', { name: 'Test Domain' })
    await store.relate(memId, 'owned_by', 'domain:test', { attributes: {}, owned_at: Date.now() })

    await processor.processNext()

    // Verify inbox tag is removed
    const tags = await store.traverse<{ id: string }>(memId, '->tagged->tag')
    const inboxTags = tags.filter(t => String(t.id) === 'tag:inbox')
    expect(inboxTags.length).toBe(0)
  })

  test('emits inboxProcessed event', async () => {
    const emittedEvents: unknown[] = []
    events.on('inboxProcessed', (...args: unknown[]) => {
      emittedEvents.push(args[0])
    })

    const memId = await store.createNode('memory', {
      content: 'event test',
      created_at: Date.now(),
      token_count: 5,
    })
    await store.createNodeWithId('tag:inbox', { label: 'inbox', created_at: Date.now() })
    await store.relate(memId, 'tagged', 'tag:inbox')
    await store.createNodeWithId('domain:test', { name: 'Test Domain' })
    await store.relate(memId, 'owned_by', 'domain:test', { attributes: {}, owned_at: Date.now() })

    await processor.processNext()

    expect(emittedEvents.length).toBe(1)
    expect((emittedEvents[0] as { memoryId: string }).memoryId).toBe(memId)
  })

  test('processes memory with multiple owning domains', async () => {
    const secondProcessed: OwnedMemory[] = []
    const secondDomain: DomainConfig = {
      id: 'second',
      name: 'Second Domain',
      async processInboxItem(entry: OwnedMemory, _ctx: DomainContext) {
        secondProcessed.push(entry)
      },
    }
    domainRegistry.register(secondDomain)

    const memId = await store.createNode('memory', {
      content: 'multi-domain content',
      created_at: Date.now(),
      token_count: 5,
    })
    await store.createNodeWithId('tag:inbox', { label: 'inbox', created_at: Date.now() })
    await store.relate(memId, 'tagged', 'tag:inbox')
    await store.createNodeWithId('domain:test', { name: 'Test Domain' })
    await store.createNodeWithId('domain:second', { name: 'Second Domain' })
    await store.relate(memId, 'owned_by', 'domain:test', { attributes: {}, owned_at: Date.now() })
    await store.relate(memId, 'owned_by', 'domain:second', { attributes: {}, owned_at: Date.now() })

    await processor.processNext()

    expect(processedItems.length).toBe(1)
    expect(secondProcessed.length).toBe(1)
    expect(processedItems[0].memory.content).toBe('multi-domain content')
    expect(secondProcessed[0].memory.content).toBe('multi-domain content')
  })
})
