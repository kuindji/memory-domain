import { parseArgs } from './parse-args.ts'
import { formatOutput, formatError } from './format.ts'
import { getHelpText, getCommandHelp } from './commands/help.ts'
import { domainsCommand, domainCommand } from './commands/domains.ts'
import { ingestCommand } from './commands/ingest.ts'
import { searchCommand } from './commands/search.ts'
import { askCommand } from './commands/ask.ts'
import { buildContextCommand } from './commands/build-context.ts'
import { writeCommand } from './commands/write.ts'
import { memoryCommand } from './commands/memory.ts'
import { graphCommand } from './commands/graph.ts'
import { scheduleCommand } from './commands/schedule.ts'
import { initCommand } from './commands/init.ts'
import { loadConfig } from '../config-loader.ts'
import type { CommandHandler, CommandResult } from './types.ts'

const COMMANDS: Record<string, CommandHandler> = {
  init: initCommand,
  ingest: ingestCommand,
  search: searchCommand,
  ask: askCommand,
  'build-context': buildContextCommand,
  domains: domainsCommand,
  domain: domainCommand,
  write: writeCommand,
  memory: memoryCommand,
  graph: graphCommand,
  schedule: scheduleCommand,
}

async function main(): Promise<void> {
  const parsed = parseArgs(Bun.argv.slice(2))

  // Handle help early (no engine needed)
  if (parsed.command === 'help') {
    const specificHelp = parsed.args[0] ? getCommandHelp(parsed.args[0]) : null
    console.log(specificHelp ?? getHelpText())
    process.exit(0)
  }

  const handler = COMMANDS[parsed.command]
  if (!handler) {
    console.error(`Unknown command: ${parsed.command}\n`)
    console.log(getHelpText())
    process.exit(1)
  }

  const pretty = parsed.flags['pretty'] === true

  // Load engine from config
  let engine
  try {
    const cwd = typeof parsed.flags['cwd'] === 'string' ? parsed.flags['cwd'] : undefined
    const config = typeof parsed.flags['config'] === 'string' ? parsed.flags['config'] : undefined
    engine = await loadConfig(cwd, config)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(formatError('CONFIG_ERROR', message))
    process.exit(1)
  }

  try {
    const result: CommandResult = await handler(engine, parsed)

    // Command-level validation errors: output has an error property with exitCode 1
    if (result.exitCode !== 0 && result.output && typeof result.output === 'object' && 'error' in result.output) {
      const errorMsg = (result.output as { error: string }).error
      console.error(formatError('VALIDATION_ERROR', errorMsg))
      process.exit(result.exitCode)
    }

    const formatCommand = result.formatCommand ?? parsed.command
    const output = formatOutput(formatCommand, result.output, pretty)

    if (output) {
      console.log(output)
    }

    process.exit(result.exitCode)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(formatError('COMMAND_ERROR', message))
    process.exit(1)
  } finally {
    await engine.close()
  }
}

void main()
