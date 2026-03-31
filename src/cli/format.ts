import type {
  DomainSummary,
  DomainSkill,
  IngestResult,
  SearchResult,
  AskResult,
  ContextResult,
  ScoredMemory,
} from '../core/types.ts'

interface JsonEnvelope {
  ok: true
  data: unknown
}

interface JsonError {
  ok: false
  error: {
    code: string
    message: string
  }
}

function padRight(str: string, length: number): string {
  return str + ' '.repeat(Math.max(0, length - str.length))
}

function formatDomains(data: DomainSummary[]): string {
  if (data.length === 0) return ''

  const maxIdLen = Math.max(...data.map((d) => d.id.length))
  const maxNameLen = Math.max(...data.map((d) => d.name.length))

  return data
    .map((d) => {
      const id = padRight(d.id, maxIdLen)
      const name = padRight(d.name, maxNameLen)
      const desc = d.description ?? 'No description'
      const parts: string[] = []
      if (d.skillCount > 0) {
        parts.push(`${d.skillCount} skill${d.skillCount === 1 ? '' : 's'}`)
      }
      if (d.hasStructure) {
        parts.push('has structure')
      }
      const paren = parts.length > 0 ? `  (${parts.join(', ')})` : ''
      return `${id}   ${name}   ${desc}${paren}`
    })
    .join('\n')
}

function formatDomainSkills(data: { domainId: string; skills: DomainSkill[] }): string {
  const { skills } = data
  if (skills.length === 0) return ''

  const maxIdLen = Math.max(...skills.map((s) => s.id.length))
  const maxNameLen = Math.max(...skills.map((s) => s.name.length))

  return skills
    .map((s) => {
      const id = padRight(s.id, maxIdLen)
      const name = padRight(s.name, maxNameLen)
      return `${id}   ${name}   ${s.description}`
    })
    .join('\n')
}

function formatIngest(data: IngestResult): string {
  if (data.action === 'stored') {
    return `Stored memory ${data.id ?? ''}`
  }
  if (data.action === 'reinforced') {
    return `Reinforced memory ${data.id ?? ''} (existing: ${data.existingId ?? ''})`
  }
  // skipped
  return `Skipped (duplicate of ${data.existingId ?? ''})`
}

function formatScoredMemory(entry: ScoredMemory): string {
  const score = entry.score.toFixed(2)
  const preview =
    entry.content.length > 200 ? entry.content.slice(0, 200) + '...' : entry.content
  const tagLine = entry.tags.length > 0 ? `\nTags: ${entry.tags.join(', ')}` : ''
  return `[${score}] memory:${entry.id}\n${preview}${tagLine}`
}

function formatSearch(data: SearchResult): string {
  const entries = data.entries.map(formatScoredMemory).join('\n\n')
  const summary = `Found ${data.entries.length} result${data.entries.length === 1 ? '' : 's'} (${data.totalTokens} tokens, mode: ${data.mode})`
  return entries.length > 0 ? `${entries}\n\n${summary}` : summary
}

function formatAsk(data: AskResult): string {
  return `${data.answer}\n\n--- ${data.memories.length} memories, ${data.rounds} rounds ---`
}

function formatBuildContext(data: ContextResult): string {
  return `${data.context}\n\n--- ${data.memories.length} memories, ${data.totalTokens} tokens ---`
}

function formatOutput(command: string, data: unknown, pretty: boolean): string {
  if (!pretty) {
    const envelope: JsonEnvelope = { ok: true, data }
    return JSON.stringify(envelope)
  }

  switch (command) {
    case 'domains':
      return formatDomains(data as DomainSummary[])

    case 'domain-structure': {
      const ds = data as { domainId: string; structure: string }
      return ds.structure
    }

    case 'domain-skills':
      return formatDomainSkills(data as { domainId: string; skills: DomainSkill[] })

    case 'domain-skill':
    case 'skill':
      return (data as { content: string }).content

    case 'ingest':
      return formatIngest(data as IngestResult)

    case 'search':
      return formatSearch(data as SearchResult)

    case 'ask':
      return formatAsk(data as AskResult)

    case 'build-context':
      return formatBuildContext(data as ContextResult)

    default: {
      const envelope: JsonEnvelope = { ok: true, data }
      return JSON.stringify(envelope)
    }
  }
}

function formatError(code: string, message: string): string {
  const envelope: JsonError = { ok: false, error: { code, message } }
  return JSON.stringify(envelope)
}

export { formatOutput, formatError }
