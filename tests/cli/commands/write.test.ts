import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { StringRecordId } from 'surrealdb'
import { MemoryEngine } from '../../../src/core/engine.ts'
import { MockLLMAdapter } from '../../helpers.ts'
import { writeCommand } from '../../../src/cli/commands/write.ts'
import type { ParsedCommand } from '../../../src/cli/types.ts'

function makeParsed(
  flags: Record<string, string | boolean | Record<string, string>> = {}
): ParsedCommand {
  return {
    command: 'write',
    args: [],
    flags: { ...flags },
  }
}

describe('writeCommand', () => {
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

  it('creates memory with required flags', async () => {
    const parsed = makeParsed({ domain: 'work', text: 'Test memory content' })
    const result = await writeCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { id: string }
    expect(output.id).toBeTruthy()
  })

  it('returns error when --domain is missing', async () => {
    const parsed = makeParsed({ text: 'Some text' })
    const result = await writeCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/--domain is required/)
  })

  it('returns error when --text is missing', async () => {
    const parsed = makeParsed({ domain: 'work' })
    const result = await writeCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/--text is required/)
  })

  it('passes tags to engine', async () => {
    const parsed = makeParsed({ domain: 'work', text: 'Tagged memory', tags: 'foo,bar' })
    const result = await writeCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { id: string }
    const tagged = await engine.getGraph().query<{ out: string }[]>(
      'SELECT out FROM tagged WHERE in = $id',
      { id: new StringRecordId(output.id) }
    )
    const tagIds = (tagged ?? []).map(t => String(t.out))
    expect(tagIds).toContain('tag:foo')
    expect(tagIds).toContain('tag:bar')
  })

  it('passes attributes via --attr', async () => {
    const parsed = makeParsed({
      domain: 'work',
      text: 'Memory with attrs',
      attr: { priority: 'high' },
    })
    const result = await writeCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { id: string }
    expect(output.id).toBeTruthy()
  })

  it('passes meta as context', async () => {
    const parsed = makeParsed({
      domain: 'work',
      text: 'Memory with context',
      meta: { sessionId: 'abc123' },
    })
    const result = await writeCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { id: string }
    expect(output.id).toBeTruthy()
  })
})
