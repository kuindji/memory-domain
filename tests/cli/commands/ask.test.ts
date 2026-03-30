import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../../../src/core/engine.ts'
import { MockLLMAdapter } from '../../helpers.ts'
import { askCommand } from '../../../src/cli/commands/ask.ts'
import type { ParsedCommand } from '../../../src/cli/types.ts'
import type { AskResult } from '../../../src/core/types.ts'

function makeParsed(args: string[], flags: Record<string, string | boolean> = {}): ParsedCommand {
  return {
    command: 'ask',
    args,
    flags: { json: false, ...flags },
  }
}

describe('askCommand', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    // generate() returns JSON with { answer: "..." } so ask() skips search rounds
    llm.generateResult = '{"answer":"Test answer"}'
    llm.synthesizeResult = 'Final answer'

    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_ask_${Date.now()}`,
      llm,
    })

    await engine.ingest('The quick brown fox jumps over the lazy dog')
    await engine.ingest('Meeting notes for project kickoff on monday')
  })

  afterEach(async () => {
    await engine.close()
  })

  it('returns error when no question is provided', async () => {
    const result = await askCommand(engine, makeParsed([]))
    expect(result.exitCode).toBe(1)
    expect((result.output as { error: string }).error).toBe('Question is required.')
  })

  it('returns result for a valid question', async () => {
    const result = await askCommand(engine, makeParsed(['What is the fox doing?']))
    expect(result.exitCode).toBe(0)
    const output = result.output as AskResult
    expect(typeof output.answer).toBe('string')
    expect(Array.isArray(output.memories)).toBe(true)
    expect(typeof output.rounds).toBe('number')
  })

  it('result has answer, memories, rounds fields', async () => {
    const result = await askCommand(engine, makeParsed(['Tell me about meetings']))
    expect(result.exitCode).toBe(0)
    const output = result.output as AskResult
    expect('answer' in output).toBe(true)
    expect('memories' in output).toBe(true)
    expect('rounds' in output).toBe(true)
  })

  it('passes domains flag to engine', async () => {
    const result = await askCommand(engine, makeParsed(['What happened?'], { domains: 'log,notes' }))
    expect(result.exitCode).toBe(0)
    const output = result.output as AskResult
    expect(typeof output.answer).toBe('string')
  })

  it('passes tags flag to engine', async () => {
    const result = await askCommand(engine, makeParsed(['What happened?'], { tags: 'work' }))
    expect(result.exitCode).toBe(0)
    expect(result.output).toBeDefined()
  })

  it('passes budget flag to engine', async () => {
    const result = await askCommand(engine, makeParsed(['What happened?'], { budget: '4000' }))
    expect(result.exitCode).toBe(0)
    expect(result.output).toBeDefined()
  })

  it('passes limit flag to engine', async () => {
    const result = await askCommand(engine, makeParsed(['What happened?'], { limit: '5' }))
    expect(result.exitCode).toBe(0)
    expect(result.output).toBeDefined()
  })
})
