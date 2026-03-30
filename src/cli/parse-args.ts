import type { ParsedCommand } from './types.ts'

const BOOLEAN_FLAGS = new Set(['json', 'skip-dedup', 'help'])

function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    return { command: 'help', args: [], flags: { json: false } }
  }

  const args: string[] = []
  const flags: ParsedCommand['flags'] = { json: false }
  let command = ''

  let i = 0
  while (i < argv.length) {
    const token = argv[i]

    if (token.startsWith('--')) {
      const raw = token.slice(2)
      const eqIdx = raw.indexOf('=')

      if (eqIdx !== -1) {
        const key = raw.slice(0, eqIdx)
        const value = raw.slice(eqIdx + 1)
        flags[key] = value
      } else if (BOOLEAN_FLAGS.has(raw)) {
        flags[raw] = true
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[raw] = next
          i++
        } else {
          flags[raw] = true
        }
      }
    } else if (command === '') {
      command = token
    } else {
      args.push(token)
    }

    i++
  }

  if (flags['help'] === true) {
    return { command: 'help', args, flags }
  }

  if (command === '') {
    return { command: 'help', args, flags }
  }

  return { command, args, flags }
}

export { parseArgs }
