import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { StringRecordId } from 'surrealdb'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'
import type {
  WriteOptions,
  WriteResult,
  UpdateOptions,
  ScheduleInfo,
  TraversalNode,
} from '../src/core/types.ts'

// --- Type-level compile checks (Task 1) ---

function checkWriteOptions(o: WriteOptions): void {
  const _domain: string = o.domain
  const _tags: string[] | undefined = o.tags
  const _attrs: Record<string, unknown> | undefined = o.attributes
  void _domain; void _tags; void _attrs
}

function checkWriteResult(r: WriteResult): void {
  const _id: string = r.id
  void _id
}

function checkUpdateOptions(o: UpdateOptions): void {
  const _text: string | undefined = o.text
  const _attrs: Record<string, unknown> | undefined = o.attributes
  void _text; void _attrs
}

function checkScheduleInfo(s: ScheduleInfo): void {
  const _id: string = s.id
  const _domain: string = s.domain
  const _name: string = s.name
  const _interval: number = s.interval
  const _lastRun: number | undefined = s.lastRun
  void _id; void _domain; void _name; void _interval; void _lastRun
}

function checkTraversalNode(n: TraversalNode): void {
  const _id: string = n.id
  const _depth: number = n.depth
  const _edge: string = n.edge
  const _dir: 'in' | 'out' = n.direction
  void _id; void _depth; void _edge; void _dir
}

// Exercise type checks so they are not tree-shaken
it('types compile correctly', () => {
  const wo: WriteOptions = { domain: 'test', tags: ['a'], attributes: { k: 1 } }
  const wr: WriteResult = { id: 'memory:abc' }
  const uo: UpdateOptions = { text: 'hi', attributes: { x: 2 } }
  const si: ScheduleInfo = { id: 'sched:1', domain: 'd', name: 'n', interval: 60000 }
  const tn: TraversalNode = { id: 'memory:1', depth: 1, edge: 'reinforces', direction: 'out' }
  checkWriteOptions(wo)
  checkWriteResult(wr)
  checkUpdateOptions(uo)
  checkScheduleInfo(si)
  checkTraversalNode(tn)
  expect(wo.domain).toBe('test')
  expect(wr.id).toBe('memory:abc')
  expect(uo.text).toBe('hi')
  expect(si.interval).toBe(60000)
  expect(tn.direction).toBe('out')
})

// --- writeMemory tests (Task 2) ---

describe('MemoryEngine.writeMemory', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_write_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  it('creates memory with domain ownership', async () => {
    const result = await engine.writeMemory('hello world', { domain: 'log' })
    expect(result.id).toBeTruthy()
    expect(result.id).toMatch(/^memory:/)

    const owners = await engine.getGraph().query<{ out: string }[]>(
      'SELECT out FROM owned_by WHERE in = $id',
      { id: new StringRecordId(result.id) }
    )
    const ownerIds = (owners ?? []).map(o => String(o.out))
    expect(ownerIds).toContain('domain:log')
  })

  it('assigns tags when provided', async () => {
    const result = await engine.writeMemory('tagged content', {
      domain: 'log',
      tags: ['work', 'important'],
    })

    const tagged = await engine.getGraph().query<{ out: string }[]>(
      'SELECT out FROM tagged WHERE in = $id',
      { id: new StringRecordId(result.id) }
    )
    const tagIds = (tagged ?? []).map(o => String(o.out))
    expect(tagIds).toContain('tag:work')
    expect(tagIds).toContain('tag:important')
  })

  it('sets domain attributes when provided', async () => {
    const result = await engine.writeMemory('attributed content', {
      domain: 'log',
      attributes: { source: 'test', priority: 1 },
    })

    const edges = await engine.getGraph().query<{ attributes: Record<string, unknown> }[]>(
      'SELECT attributes FROM owned_by WHERE in = $id AND out = domain:log',
      { id: new StringRecordId(result.id) }
    )
    expect(edges).toBeTruthy()
    expect(edges?.[0].attributes.source).toBe('test')
    expect(edges?.[0].attributes.priority).toBe(1)
  })

  it('does not tag with inbox', async () => {
    const result = await engine.writeMemory('direct memory', { domain: 'log' })

    const tagged = await engine.getGraph().query<{ out: string }[]>(
      'SELECT out FROM tagged WHERE in = $id',
      { id: new StringRecordId(result.id) }
    )
    const tagIds = (tagged ?? []).map(o => String(o.out))
    expect(tagIds).not.toContain('tag:inbox')
  })
})

// --- getMemory / updateMemory / deleteMemory tests (Task 3) ---

describe('MemoryEngine CRUD methods', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_crud_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  it('reads an existing memory', async () => {
    const { id } = await engine.writeMemory('readable content', { domain: 'log' })
    const entry = await engine.getMemory(id)
    expect(entry).not.toBeNull()
    expect(entry!.id).toBe(id)
    expect(entry!.content).toBe('readable content')
    expect(typeof entry!.createdAt).toBe('number')
    expect(typeof entry!.tokenCount).toBe('number')
  })

  it('returns null for non-existent memory', async () => {
    const entry = await engine.getMemory('memory:nonexistent123')
    expect(entry).toBeNull()
  })

  it('updates text of existing memory', async () => {
    const { id } = await engine.writeMemory('original text', { domain: 'log' })
    await engine.updateMemory(id, { text: 'updated text' })
    const entry = await engine.getMemory(id)
    expect(entry!.content).toBe('updated text')
  })

  it('update recalculates token count', async () => {
    const { id } = await engine.writeMemory('short', { domain: 'log' })
    const before = await engine.getMemory(id)
    await engine.updateMemory(id, { text: 'a much longer piece of text with many more tokens than before' })
    const after = await engine.getMemory(id)
    expect(after!.tokenCount).toBeGreaterThan(before!.tokenCount)
  })

  it('deletes a memory', async () => {
    const { id } = await engine.writeMemory('to be deleted', { domain: 'log' })
    await engine.deleteMemory(id)
    const entry = await engine.getMemory(id)
    expect(entry).toBeNull()
  })

  it('throws when updating non-existent memory', () => {
    expect(
      engine.updateMemory('memory:nonexistent456', { text: 'new text' })
    ).rejects.toThrow('Memory not found')
  })

  it('throws when deleting non-existent memory', () => {
    expect(
      engine.deleteMemory('memory:nonexistent789')
    ).rejects.toThrow('Memory not found')
  })
})

// --- tagMemory / untagMemory / getMemoryTags tests (Task 4) ---

describe('MemoryEngine tagging methods', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_tags_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  it('adds a tag to a memory', async () => {
    const { id } = await engine.writeMemory('tagme', { domain: 'log' })
    await engine.tagMemory(id, 'mytag')
    const tags = await engine.getMemoryTags(id)
    expect(tags).toContain('mytag')
  })

  it('removes a tag from a memory', async () => {
    const { id } = await engine.writeMemory('tagme2', { domain: 'log' })
    await engine.tagMemory(id, 'removeme')
    await engine.untagMemory(id, 'removeme')
    const tags = await engine.getMemoryTags(id)
    expect(tags).not.toContain('removeme')
  })

  it('lists multiple tags', async () => {
    const { id } = await engine.writeMemory('multi-tagged', { domain: 'log' })
    await engine.tagMemory(id, 'alpha')
    await engine.tagMemory(id, 'beta')
    await engine.tagMemory(id, 'gamma')
    const tags = await engine.getMemoryTags(id)
    expect(tags).toContain('alpha')
    expect(tags).toContain('beta')
    expect(tags).toContain('gamma')
  })

  it('returns empty array for non-existent memory', async () => {
    const tags = await engine.getMemoryTags('memory:doesnotexist')
    expect(tags).toEqual([])
  })
})
