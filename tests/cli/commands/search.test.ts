import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../../../src/core/engine.ts'
import { MockLLMAdapter } from '../../helpers.ts'
import searchCommand from '../../../src/cli/commands/search.ts'
import type { ParsedCommand } from '../../../src/cli/types.ts'

function makeParsed(args: string[], flags: Record<string, string | boolean> = {}): ParsedCommand {
  return {
    command: 'search',
    args,
    flags: { json: false, ...flags },
  }
}

describe('searchCommand', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_search_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })

    await engine.ingest('The quick brown fox jumps over the lazy dog')
    await engine.ingest('Meeting notes for project kickoff on monday')
    await engine.ingest('Shopping list: milk, eggs, bread')
  })

  afterEach(async () => {
    await engine.close()
  })

  it('returns error when no query is provided', async () => {
    const result = await searchCommand(engine, makeParsed([]))
    expect(result.exitCode).toBe(1)
    expect((result.output as { error: string }).error).toBe('Search query is required.')
  })

  it('returns results for a valid query', async () => {
    const result = await searchCommand(engine, makeParsed(['fox']))
    expect(result.exitCode).toBe(0)
    const output = result.output as { entries: unknown[]; totalTokens: number; mode: string }
    expect(Array.isArray(output.entries)).toBe(true)
    expect(typeof output.totalTokens).toBe('number')
    expect(typeof output.mode).toBe('string')
  })

  it('result has correct shape with entries, totalTokens, mode', async () => {
    const result = await searchCommand(engine, makeParsed(['meeting']))
    expect(result.exitCode).toBe(0)
    const output = result.output as { entries: unknown[]; totalTokens: number; mode: string }
    expect('entries' in output).toBe(true)
    expect('totalTokens' in output).toBe(true)
    expect('mode' in output).toBe(true)
  })

  it('passes mode flag to engine', async () => {
    const result = await searchCommand(engine, makeParsed(['notes'], { mode: 'fulltext' }))
    expect(result.exitCode).toBe(0)
    const output = result.output as { entries: unknown[]; totalTokens: number; mode: string }
    expect(output.mode).toBe('fulltext')
  })

  it('passes limit flag to engine', async () => {
    const result = await searchCommand(engine, makeParsed(['the'], { limit: '1', mode: 'fulltext' }))
    expect(result.exitCode).toBe(0)
    const output = result.output as { entries: unknown[]; totalTokens: number; mode: string }
    expect(output.entries.length).toBeLessThanOrEqual(1)
  })

  it('passes domains flag to engine', async () => {
    const result = await searchCommand(engine, makeParsed(['fox'], { domains: 'log' }))
    expect(result.exitCode).toBe(0)
    const output = result.output as { entries: unknown[]; totalTokens: number; mode: string }
    expect(Array.isArray(output.entries)).toBe(true)
  })
})
