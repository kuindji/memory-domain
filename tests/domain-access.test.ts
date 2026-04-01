import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { StringRecordId } from 'surrealdb'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'
import type { DomainConfig } from '../src/core/types.ts'

function makeDomain(id: string): DomainConfig {
  return {
    id,
    name: id,
    async processInboxItem() {},
  }
}

describe('Domain access enforcement', () => {
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

  test('writeMemory rejects for read-only domain', async () => {
    await engine.registerDomain(makeDomain('ro'), { access: 'read' })

    expect(
      engine.writeMemory('test', { domain: 'ro' })
    ).rejects.toThrow('Domain "ro" is registered as read-only')
  })

  test('ingest removes read-only domains from target list', async () => {
    await engine.registerDomain(makeDomain('rw'), { access: 'write' })
    await engine.registerDomain(makeDomain('ro'), { access: 'read' })

    const result = await engine.ingest('test', { domains: ['rw', 'ro'] })
    expect(result.action).toBe('stored')

    const graph = engine.getGraph()
    const owners = await graph.query<{ out: unknown }[]>(
      `SELECT out FROM owned_by WHERE in = $memId`,
      { memId: new StringRecordId(result.id!) }
    )
    const domainIds = (owners ?? []).map(o => String(o.out))
    expect(domainIds).toContain('domain:rw')
    expect(domainIds).not.toContain('domain:ro')
  })

  // TODO: This test will work after Task 6 removes the hardcoded log domain injection.
  // Currently, even when all explicitly requested domains are read-only, the log domain
  // (which is writable) gets added to the target list, so no error is thrown.
  test.skip('ingest errors when all requested domains are read-only', async () => {
    await engine.registerDomain(makeDomain('ro'), { access: 'read' })

    expect(
      engine.ingest('test', { domains: ['ro'] })
    ).rejects.toThrow('read-only')
  })

  test('relate rejects for read-only domain', async () => {
    await engine.registerDomain(makeDomain('ro'), { access: 'read' })
    await engine.registerDomain(makeDomain('rw'))

    const result = await engine.ingest('test', { domains: ['rw'] })

    expect(
      engine.relate(result.id!, 'tag:test', 'about_topic', 'ro')
    ).rejects.toThrow('Domain "ro" is registered as read-only')
  })

  test('releaseOwnership rejects for read-only domain', async () => {
    await engine.registerDomain(makeDomain('ro'), { access: 'read' })

    expect(
      engine.releaseOwnership('memory:fake', 'ro')
    ).rejects.toThrow('Domain "ro" is registered as read-only')
  })

  test('search works for read-only domains', async () => {
    await engine.registerDomain(makeDomain('ro'), { access: 'read' })

    const result = await engine.search({ domains: ['ro'], mode: 'graph', limit: 10 })
    expect(result.entries).toEqual([])
  })
})

describe('autoOwn', () => {
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

  test('autoOwn domain gets ownership even when not in target list', async () => {
    await engine.registerDomain({
      ...makeDomain('auto'),
      settings: { autoOwn: true },
    })
    await engine.registerDomain(makeDomain('explicit'))

    const result = await engine.ingest('test', { domains: ['explicit'] })

    const graph = engine.getGraph()
    const owners = await graph.query<{ out: unknown }[]>(
      `SELECT out FROM owned_by WHERE in = $memId`,
      { memId: new StringRecordId(result.id!) }
    )
    const domainIds = (owners ?? []).map(o => String(o.out))
    expect(domainIds).toContain('domain:explicit')
    expect(domainIds).toContain('domain:auto')
  })

  test('autoOwn read-only domain does not get ownership', async () => {
    await engine.registerDomain(
      { ...makeDomain('auto-ro'), settings: { autoOwn: true } },
      { access: 'read' }
    )
    await engine.registerDomain(makeDomain('rw'))

    const result = await engine.ingest('test', { domains: ['rw'] })

    const graph = engine.getGraph()
    const owners = await graph.query<{ out: unknown }[]>(
      `SELECT out FROM owned_by WHERE in = $memId`,
      { memId: new StringRecordId(result.id!) }
    )
    const domainIds = (owners ?? []).map(o => String(o.out))
    expect(domainIds).toContain('domain:rw')
    expect(domainIds).not.toContain('domain:auto-ro')
  })

  test('autoOwn domain already in target list is not duplicated', async () => {
    await engine.registerDomain({
      ...makeDomain('auto'),
      settings: { autoOwn: true },
    })

    const result = await engine.ingest('test', { domains: ['auto'] })

    const graph = engine.getGraph()
    const owners = await graph.query<{ out: unknown }[]>(
      `SELECT out FROM owned_by WHERE in = $memId`,
      { memId: new StringRecordId(result.id!) }
    )
    const domainIds = (owners ?? []).map(o => String(o.out))
    const autoCount = domainIds.filter(id => id === 'domain:auto').length
    expect(autoCount).toBe(1)
  })
})
