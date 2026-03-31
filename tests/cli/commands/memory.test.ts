import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../../../src/core/engine.ts'
import { MockLLMAdapter } from '../../helpers.ts'
import { memoryCommand } from '../../../src/cli/commands/memory.ts'
import type { ParsedCommand } from '../../../src/cli/types.ts'

function makeParsed(
  args: string[] = [],
  flags: Record<string, string | boolean | Record<string, string>> = {}
): ParsedCommand {
  return {
    command: 'memory',
    args,
    flags: { ...flags },
  }
}

describe('memoryCommand', () => {
  let engine: MemoryEngine
  let memoryId: string

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_memory_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
    const result = await engine.writeMemory('Initial content', { domain: 'work' })
    memoryId = result.id
  })

  afterEach(async () => {
    await engine.close()
  })

  it('reads memory by id', async () => {
    const parsed = makeParsed([memoryId])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { id: string; content: string; tags: string[] }
    expect(output.content).toBe('Initial content')
    expect(Array.isArray(output.tags)).toBe(true)
  })

  it('returns error for missing id', async () => {
    const parsed = makeParsed([])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/id is required/)
  })

  it('returns error for non-existent memory', async () => {
    const parsed = makeParsed(['memory:nonexistent'])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/not found/)
  })

  it('updates text', async () => {
    const parsed = makeParsed([memoryId, 'update'], { text: 'Updated content' })
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { content: string }
    expect(output.content).toBe('Updated content')
  })

  it('updates attributes', async () => {
    const parsed = makeParsed([memoryId, 'update'], { attr: { status: 'done' } })
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
  })

  it('returns error for update with no fields', async () => {
    const parsed = makeParsed([memoryId, 'update'])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/--text or --attr is required/)
  })

  it('lists tags', async () => {
    await engine.tagMemory(memoryId, 'mytag')
    const parsed = makeParsed([memoryId, 'tags'])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { tags: string[] }
    expect(output.tags).toContain('mytag')
  })

  it('adds a tag', async () => {
    const parsed = makeParsed([memoryId, 'tag', 'newtag'])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { tags: string[] }
    expect(output.tags).toContain('newtag')
  })

  it('removes a tag', async () => {
    await engine.tagMemory(memoryId, 'removeme')
    const parsed = makeParsed([memoryId, 'untag', 'removeme'])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { tags: string[] }
    expect(output.tags).not.toContain('removeme')
  })

  it('releases ownership', async () => {
    const parsed = makeParsed([memoryId, 'release'], { domain: 'work' })
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { released: boolean }
    expect(output.released).toBe(true)
  })

  it('deletes memory', async () => {
    const parsed = makeParsed([memoryId, 'delete'])
    const result = await memoryCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { deleted: boolean }
    expect(output.deleted).toBe(true)

    const mem = await engine.getMemory(memoryId)
    expect(mem).toBeNull()
  })
})
