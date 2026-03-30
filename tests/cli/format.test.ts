import { describe, it, expect } from 'bun:test'
import { formatOutput } from '../../src/cli/format.ts'
import type {
  DomainSummary,
  DomainSkill,
  IngestResult,
  SearchResult,
  AskResult,
  ContextResult,
  ScoredMemory,
} from '../../src/core/types.ts'

const makeScoredMemory = (overrides: Partial<ScoredMemory> = {}): ScoredMemory => ({
  id: 'mem1',
  content: 'Sample memory content',
  score: 0.85,
  scores: { vector: 0.85 },
  tags: ['tag1', 'tag2'],
  domainAttributes: {},
  eventTime: null,
  createdAt: 1000000,
  ...overrides,
})

describe('formatOutput - JSON mode', () => {
  it('returns JSON for domains command', () => {
    const data: DomainSummary[] = [
      { id: 'dom1', name: 'Domain One', hasStructure: true, skillCount: 3 },
    ]
    const result = formatOutput('domains', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })

  it('returns JSON for domain-structure command', () => {
    const data = { domainId: 'dom1', structure: 'some structure' }
    const result = formatOutput('domain-structure', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })

  it('returns JSON for domain-skills command', () => {
    const skills: DomainSkill[] = [
      { id: 'sk1', name: 'Skill One', description: 'A skill', scope: 'internal' },
    ]
    const data = { domainId: 'dom1', skills }
    const result = formatOutput('domain-skills', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })

  it('returns JSON for domain-skill command', () => {
    const skill = {
      id: 'sk1',
      name: 'Skill One',
      description: 'A skill',
      scope: 'external',
      content: 'full content',
    }
    const result = formatOutput('domain-skill', skill, true)
    expect(JSON.parse(result)).toEqual(skill)
  })

  it('returns JSON for ingest command', () => {
    const data: IngestResult = { action: 'stored', id: 'abc123' }
    const result = formatOutput('ingest', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })

  it('returns JSON for search command', () => {
    const data: SearchResult = {
      entries: [makeScoredMemory()],
      totalTokens: 100,
      mode: 'hybrid',
    }
    const result = formatOutput('search', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })

  it('returns JSON for ask command', () => {
    const data: AskResult = {
      answer: 'The answer',
      memories: [makeScoredMemory()],
      rounds: 2,
    }
    const result = formatOutput('ask', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })

  it('returns JSON for build-context command', () => {
    const data: ContextResult = {
      context: 'The context text',
      memories: [makeScoredMemory()],
      totalTokens: 512,
    }
    const result = formatOutput('build-context', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })

  it('returns JSON for error command', () => {
    const data = { error: 'Something went wrong' }
    const result = formatOutput('error', data, true)
    expect(JSON.parse(result)).toEqual(data)
  })
})

describe('formatOutput - text mode: domains', () => {
  it('formats domains with description, skills, and structure', () => {
    const data: DomainSummary[] = [
      { id: 'domain-id', name: 'Domain Name', description: 'Description text', hasStructure: true, skillCount: 3 },
      { id: 'other-id', name: 'Other Name', hasStructure: false, skillCount: 0 },
    ]
    const result = formatOutput('domains', data, false)
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('domain-id')
    expect(lines[0]).toContain('Domain Name')
    expect(lines[0]).toContain('Description text')
    expect(lines[0]).toContain('3 skills')
    expect(lines[0]).toContain('has structure')
    expect(lines[1]).toContain('other-id')
    expect(lines[1]).toContain('Other Name')
    expect(lines[1]).toContain('No description')
    expect(lines[1]).not.toContain('skills')
    expect(lines[1]).not.toContain('has structure')
  })

  it('shows singular "skill" for skillCount of 1', () => {
    const data: DomainSummary[] = [
      { id: 'dom1', name: 'Domain', hasStructure: false, skillCount: 1 },
    ]
    const result = formatOutput('domains', data, false)
    expect(result).toContain('1 skill')
    expect(result).not.toContain('1 skills')
  })

  it('returns empty string for empty domains list', () => {
    const result = formatOutput('domains', [], false)
    expect(result).toBe('')
  })

  it('pads ids to the longest', () => {
    const data: DomainSummary[] = [
      { id: 'a', name: 'Short', hasStructure: false, skillCount: 0 },
      { id: 'longer-id', name: 'Long', hasStructure: false, skillCount: 0 },
    ]
    const result = formatOutput('domains', data, false)
    const lines = result.split('\n')
    // Both should be padded: first line id 'a' padded to length of 'longer-id' (9)
    expect(lines[0].startsWith('a        ')).toBe(true)
  })
})

describe('formatOutput - text mode: domain-structure', () => {
  it('returns the structure string as-is', () => {
    const data = { domainId: 'dom1', structure: 'This is the structure\nwith multiple lines' }
    const result = formatOutput('domain-structure', data, false)
    expect(result).toBe('This is the structure\nwith multiple lines')
  })
})

describe('formatOutput - text mode: domain-skills', () => {
  it('formats skills without content', () => {
    const skills: DomainSkill[] = [
      { id: 'sk1', name: 'Skill One', description: 'First skill', scope: 'internal' },
      { id: 'sk2', name: 'Skill Two', description: 'Second skill', scope: 'external' },
    ]
    const data = { domainId: 'dom1', skills }
    const result = formatOutput('domain-skills', data, false)
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('sk1')
    expect(lines[0]).toContain('Skill One')
    expect(lines[0]).toContain('First skill')
    expect(lines[0]).not.toContain('very long content here')
    expect(lines[1]).toContain('sk2')
    expect(lines[1]).toContain('Skill Two')
    expect(lines[1]).toContain('Second skill')
  })

  it('returns empty string for empty skills list', () => {
    const result = formatOutput('domain-skills', { domainId: 'dom1', skills: [] }, false)
    expect(result).toBe('')
  })
})

describe('formatOutput - text mode: domain-skill', () => {
  it('prints the skill content', () => {
    const skill = {
      id: 'sk1',
      name: 'Skill One',
      description: 'A skill',
      scope: 'both',
      content: 'This is the full skill content.',
    }
    const result = formatOutput('domain-skill', skill, false)
    expect(result).toBe('This is the full skill content.')
  })
})

describe('formatOutput - text mode: ingest', () => {
  it('formats stored action', () => {
    const data: IngestResult = { action: 'stored', id: 'abc123' }
    const result = formatOutput('ingest', data, false)
    expect(result).toBe('Stored memory abc123')
  })

  it('formats reinforced action', () => {
    const data: IngestResult = { action: 'reinforced', id: 'abc123', existingId: 'def456' }
    const result = formatOutput('ingest', data, false)
    expect(result).toBe('Reinforced memory abc123 (existing: def456)')
  })

  it('formats skipped action', () => {
    const data: IngestResult = { action: 'skipped', existingId: 'def456' }
    const result = formatOutput('ingest', data, false)
    expect(result).toBe('Skipped (duplicate of def456)')
  })
})

describe('formatOutput - text mode: search', () => {
  it('formats search results with score, preview, and tags', () => {
    const data: SearchResult = {
      entries: [
        makeScoredMemory({ id: 'abc123', content: 'Memory content here', score: 0.85, tags: ['tag1', 'tag2'] }),
        makeScoredMemory({ id: 'def456', content: 'Other content', score: 0.72, tags: [] }),
      ],
      totalTokens: 1234,
      mode: 'hybrid',
    }
    const result = formatOutput('search', data, false)
    expect(result).toContain('[0.85] memory:abc123')
    expect(result).toContain('Memory content here')
    expect(result).toContain('Tags: tag1, tag2')
    expect(result).toContain('[0.72] memory:def456')
    expect(result).toContain('Other content')
    expect(result).toContain('Found 2 results (1234 tokens, mode: hybrid)')
  })

  it('truncates long content to 200 chars with ellipsis', () => {
    const longContent = 'A'.repeat(250)
    const data: SearchResult = {
      entries: [makeScoredMemory({ content: longContent })],
      totalTokens: 100,
      mode: 'vector',
    }
    const result = formatOutput('search', data, false)
    expect(result).toContain('A'.repeat(200) + '...')
    expect(result).not.toContain('A'.repeat(201) + 'A')
  })

  it('omits Tags line when no tags', () => {
    const data: SearchResult = {
      entries: [makeScoredMemory({ tags: [] })],
      totalTokens: 50,
      mode: 'fulltext',
    }
    const result = formatOutput('search', data, false)
    expect(result).not.toContain('Tags:')
  })

  it('uses singular "result" for single result', () => {
    const data: SearchResult = {
      entries: [makeScoredMemory()],
      totalTokens: 50,
      mode: 'vector',
    }
    const result = formatOutput('search', data, false)
    expect(result).toContain('Found 1 result (')
  })

  it('shows summary only when no entries', () => {
    const data: SearchResult = { entries: [], totalTokens: 0, mode: 'hybrid' }
    const result = formatOutput('search', data, false)
    expect(result).toBe('Found 0 results (0 tokens, mode: hybrid)')
  })
})

describe('formatOutput - text mode: ask', () => {
  it('formats answer with memory and rounds summary', () => {
    const data: AskResult = {
      answer: 'The answer to your question.',
      memories: [makeScoredMemory(), makeScoredMemory({ id: 'mem2' })],
      rounds: 2,
    }
    const result = formatOutput('ask', data, false)
    expect(result).toBe('The answer to your question.\n\n--- 2 memories, 2 rounds ---')
  })
})

describe('formatOutput - text mode: build-context', () => {
  it('formats context with memories and token summary', () => {
    const data: ContextResult = {
      context: 'The context text here.',
      memories: [makeScoredMemory(), makeScoredMemory({ id: 'mem2' }), makeScoredMemory({ id: 'mem3' })],
      totalTokens: 2048,
    }
    const result = formatOutput('build-context', data, false)
    expect(result).toBe('The context text here.\n\n--- 3 memories, 2048 tokens ---')
  })
})

describe('formatOutput - text mode: error', () => {
  it('formats error message', () => {
    const data = { error: 'Something went wrong' }
    const result = formatOutput('error', data, false)
    expect(result).toBe('Error: Something went wrong')
  })
})
