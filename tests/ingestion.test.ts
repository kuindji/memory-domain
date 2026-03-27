import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { StringRecordId } from 'surrealdb'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'

describe('MemoryEngine', () => {
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

  describe('initialize', () => {
    test('creates core schema and log domain', async () => {
      const result = await engine.search({ mode: 'graph', limit: 10 })
      expect(result.entries).toEqual([])
    })
  })

  describe('ingest', () => {
    test('stores a memory and tags it with inbox', async () => {
      const result = await engine.ingest('Test content for ingestion')
      expect(result.action).toBe('stored')
      expect(result.id).toBeTruthy()

      const memory = await engine.getGraph().getNode(result.id!)
      expect(memory).not.toBeNull()
      expect(memory!.content).toBe('Test content for ingestion')
    })

    test('assigns ownership to all registered domains', async () => {
      await engine.registerDomain({
        id: 'test_domain',
        name: 'Test',
        async processInboxItem() {},
      })

      const result = await engine.ingest('Some content')

      const owners = await engine.getGraph().query<{ out: string }[]>(
        'SELECT out FROM owned_by WHERE in = $id',
        { id: new StringRecordId(result.id!) }
      )

      const domainIds = (owners ?? []).map(o => String(o.out))
      expect(domainIds).toContain('domain:log')
      expect(domainIds).toContain('domain:test_domain')
    })

    test('ingest with specific domains targets only those domains', async () => {
      await engine.registerDomain({
        id: 'domain_a',
        name: 'A',
        async processInboxItem() {},
      })
      await engine.registerDomain({
        id: 'domain_b',
        name: 'B',
        async processInboxItem() {},
      })

      const result = await engine.ingest('Targeted content', { domains: ['domain_a'] })

      const owners = await engine.getGraph().query<{ out: string }[]>(
        'SELECT out FROM owned_by WHERE in = $id',
        { id: new StringRecordId(result.id!) }
      )

      const domainIds = (owners ?? []).map(o => String(o.out))
      expect(domainIds).toContain('domain:domain_a')
      expect(domainIds).not.toContain('domain:domain_b')
    })
  })

  describe('ref-counted deletion', () => {
    test('memory is deleted when all owners release it', async () => {
      await engine.registerDomain({
        id: 'domain_a',
        name: 'A',
        async processInboxItem() {},
      })

      const result = await engine.ingest('Owned content', { domains: ['domain_a'] })
      const memId = result.id!

      await engine.releaseOwnership(memId, 'domain_a')
      await engine.releaseOwnership(memId, 'log')

      const memory = await engine.getGraph().getNode(memId)
      expect(memory).toBeNull()
    })

    test('memory survives when one owner remains', async () => {
      await engine.registerDomain({
        id: 'domain_a',
        name: 'A',
        async processInboxItem() {},
      })

      const result = await engine.ingest('Shared content', { domains: ['domain_a'] })
      const memId = result.id!

      await engine.releaseOwnership(memId, 'domain_a')

      const memory = await engine.getGraph().getNode(memId)
      expect(memory).not.toBeNull()
    })
  })
})
