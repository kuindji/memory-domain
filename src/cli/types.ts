import type { MemoryEngine } from '../core/engine.ts'

interface GlobalFlags {
  config?: string
  json: boolean
  cwd?: string
}

interface ParsedCommand {
  command: string
  args: string[]
  flags: GlobalFlags & Record<string, string | boolean>
}

interface CommandResult {
  output: unknown
  exitCode: number
  formatCommand?: string
}

type CommandHandler = (
  engine: MemoryEngine,
  parsed: ParsedCommand,
) => Promise<CommandResult>

export type { GlobalFlags, ParsedCommand, CommandResult, CommandHandler }
