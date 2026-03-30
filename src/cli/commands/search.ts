import type { CommandHandler } from '../types.ts'
import type { SearchQuery } from '../../core/types.ts'

const searchCommand: CommandHandler = async (engine, parsed) => {
  const text = parsed.args[0]

  if (!text) {
    return { output: { error: 'Search query is required.' }, exitCode: 1 }
  }

  const query: SearchQuery = { text }

  if (parsed.flags['mode']) {
    query.mode = parsed.flags['mode'] as SearchQuery['mode']
  }
  if (parsed.flags['domains']) {
    query.domains = (parsed.flags['domains'] as string).split(',')
  }
  if (parsed.flags['tags']) {
    query.tags = (parsed.flags['tags'] as string).split(',')
  }
  if (parsed.flags['limit']) {
    query.limit = Number(parsed.flags['limit'])
  }
  if (parsed.flags['budget']) {
    query.tokenBudget = Number(parsed.flags['budget'])
  }
  if (parsed.flags['min-score']) {
    query.minScore = Number(parsed.flags['min-score'])
  }

  const result = await engine.search(query)
  return { output: result, exitCode: 0 }
}

export default searchCommand
