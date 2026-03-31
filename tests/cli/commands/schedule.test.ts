import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../../../src/core/engine.ts'
import { MockLLMAdapter } from '../../helpers.ts'
import { scheduleCommand } from '../../../src/cli/commands/schedule.ts'
import { createTopicDomain } from '../../../src/domains/topic/index.ts'
import type { ParsedCommand } from '../../../src/cli/types.ts'
import type { ScheduleInfo } from '../../../src/core/types.ts'

function makeParsed(
  args: string[] = [],
  flags: Record<string, string | boolean | Record<string, string>> = {}
): ParsedCommand {
  return {
    command: 'schedule',
    args,
    flags: { ...flags },
  }
}

describe('scheduleCommand', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_schedule_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
    await engine.registerDomain(createTopicDomain())
  })

  afterEach(async () => {
    await engine.close()
  })

  it('returns error for missing subcommand', async () => {
    const parsed = makeParsed([])
    const result = await scheduleCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/Subcommand is required/)
  })

  it('list returns schedules', async () => {
    const parsed = makeParsed(['list'])
    const result = await scheduleCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { schedules: ScheduleInfo[] }
    expect(Array.isArray(output.schedules)).toBe(true)
    expect(output.schedules.length).toBeGreaterThan(0)
  })

  it('list filters by domain', async () => {
    const parsed = makeParsed(['list'], { domain: 'topic' })
    const result = await scheduleCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { schedules: ScheduleInfo[] }
    expect(Array.isArray(output.schedules)).toBe(true)
    for (const s of output.schedules) {
      expect(s.domain).toBe('topic')
    }
  })

  it('trigger runs a schedule', async () => {
    const parsed = makeParsed(['trigger', 'topic', 'merge-similar-topics'])
    const result = await scheduleCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { triggered: boolean; domain: string; schedule: string }
    expect(output.triggered).toBe(true)
    expect(output.domain).toBe('topic')
    expect(output.schedule).toBe('merge-similar-topics')
  })

  it('trigger returns error for unknown schedule', async () => {
    const parsed = makeParsed(['trigger', 'topic', 'nonexistent-schedule'])
    const result = await scheduleCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toBeTruthy()
  })
})
