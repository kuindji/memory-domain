import { createInterface } from 'node:readline'
import type { CommandHandler } from '../types.ts'

function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise(resolve => {
    rl.question(`${message} (y/N) `, answer => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

const initCommand: CommandHandler = async (engine, parsed) => {
  const yes = parsed.flags['yes'] === true
  const noBootstrap = parsed.flags['no-bootstrap'] === true

  const summaries = engine.getDomainRegistry().listSummaries()
  const bootstrappable = engine.getBootstrappableDomains()

  const result: Record<string, unknown> = {
    initialized: true,
    domains: summaries.map(d => d.id),
  }

  if (noBootstrap || bootstrappable.length === 0) {
    result.bootstrapped = []
    return { output: result, exitCode: 0 }
  }

  // Interactive confirmation for bootstrap
  if (!yes) {
    process.stderr.write(
      `\nThe following domains have bootstrap routines that will use AI to analyze your project:\n` +
      bootstrappable.map(id => `  - ${id}`).join('\n') + '\n\n' +
      'This may incur significant API usage.\n',
    )
    const confirmed = await confirm('Run bootstrap?')
    if (!confirmed) {
      result.bootstrapped = []
      result.bootstrapSkipped = true
      return { output: result, exitCode: 0 }
    }
  }

  const bootstrapped = await engine.runBootstrap()
  result.bootstrapped = bootstrapped

  return { output: result, exitCode: 0 }
}

export { initCommand }
