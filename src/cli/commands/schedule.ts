import type { CommandHandler } from '../types.ts'

const scheduleCommand: CommandHandler = async (engine, parsed) => {
  const [subcommand, domainArg, scheduleArg] = parsed.args

  if (!subcommand) {
    return { output: { error: 'Subcommand is required: list, trigger, run-due' }, exitCode: 1 }
  }

  if (subcommand === 'list') {
    const domainId = parsed.flags['domain'] as string | undefined
    const schedules = engine.listSchedules(domainId)
    return { output: { schedules }, exitCode: 0 }
  }

  if (subcommand === 'trigger') {
    if (!domainArg || !scheduleArg) {
      return { output: { error: 'trigger requires <domain-id> <schedule-id>' }, exitCode: 1 }
    }
    try {
      await engine.triggerSchedule(domainArg, scheduleArg)
      return { output: { triggered: true, domain: domainArg, schedule: scheduleArg }, exitCode: 0 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: { error: message }, exitCode: 1 }
    }
  }

  if (subcommand === 'run-due') {
    try {
      const result = await engine.runDueSchedules()
      return { output: { ran: result.ran, count: result.ran.length }, exitCode: 0 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: { error: message }, exitCode: 1 }
    }
  }

  return { output: { error: `Unknown subcommand: ${subcommand}` }, exitCode: 1 }
}

export { scheduleCommand }
