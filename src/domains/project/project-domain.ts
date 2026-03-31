import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type {
  DomainConfig,
  DomainSchedule,
  DomainContext,
  SearchQuery,
  ScoredMemory,
  ContextResult,
} from '../../core/types.ts'
import { countTokens } from '../../core/scoring.ts'
import {
  PROJECT_DOMAIN_ID,
  PROJECT_TAG,
  PROJECT_DECISION_TAG,
  PROJECT_RATIONALE_TAG,
  PROJECT_OBSERVATION_TAG,
  DEFAULT_SCAN_INTERVAL_MS,
  DEFAULT_DRIFT_INTERVAL_MS,
} from './types.ts'
import type { ProjectDomainOptions } from './types.ts'
import { projectSkills } from './skills.ts'
import { processInboxItem } from './inbox.ts'
import { scanCommits, detectDrift } from './schedules.ts'
import { bootstrapProject } from './bootstrap.ts'

function buildSchedules(options?: ProjectDomainOptions): DomainSchedule[] {
  const schedules: DomainSchedule[] = []
  const hasProjectRoot = !!options?.projectRoot

  if (hasProjectRoot && options?.commitScanner?.enabled !== false) {
    schedules.push({
      id: 'commit-scanner',
      name: 'Scan recent commits for structural changes',
      intervalMs: options?.commitScanner?.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
      run: (context: DomainContext) => scanCommits(context, options),
    })
  }

  if (hasProjectRoot && options?.driftDetector?.enabled !== false) {
    schedules.push({
      id: 'drift-detector',
      name: 'Detect drift from recorded decisions',
      intervalMs: options?.driftDetector?.intervalMs ?? DEFAULT_DRIFT_INTERVAL_MS,
      run: (context: DomainContext) => detectDrift(context, options),
    })
  }

  return schedules
}

export function createProjectDomain(options?: ProjectDomainOptions): DomainConfig {
  return {
    id: PROJECT_DOMAIN_ID,
    name: 'Project Knowledge',
    baseDir: dirname(fileURLToPath(import.meta.url)),
    schema: {
      nodes: [
        {
          name: 'module',
          schemafull: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'path', type: 'string', required: false },
            { name: 'kind', type: 'string', required: false },
            { name: 'status', type: 'string', required: false, default: 'active' },
          ],
        },
        {
          name: 'data_entity',
          schemafull: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'source', type: 'string', required: false },
          ],
        },
        {
          name: 'concept',
          schemafull: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'description', type: 'string', required: false },
          ],
        },
        {
          name: 'pattern',
          schemafull: false,
          fields: [
            { name: 'name', type: 'string' },
            { name: 'scope', type: 'string', required: false },
          ],
        },
      ],
      edges: [
        { name: 'about_entity', from: 'memory', to: ['module', 'data_entity', 'concept', 'pattern'], fields: [{ name: 'relevance', type: 'float' }] },
        { name: 'supersedes', from: 'memory', to: 'memory' },
        { name: 'raises', from: 'memory', to: 'memory' },
        { name: 'connects_to', from: 'module', to: 'module', fields: [{ name: 'protocol', type: 'string' }, { name: 'direction', type: 'string' }, { name: 'description', type: 'string' }] },
        { name: 'manages', from: 'module', to: 'data_entity', fields: [{ name: 'role', type: 'string' }] },
        { name: 'contains', from: 'module', to: 'module' },
        { name: 'implements', from: 'module', to: 'concept' },
        { name: 'has_field', from: 'data_entity', to: 'data_entity', fields: [{ name: 'cardinality', type: 'string' }] },
      ],
    },
    skills: projectSkills,
    processInboxItem,
    schedules: buildSchedules(options),
    bootstrap: (context: DomainContext) => bootstrapProject(context, options),

    describe() {
      return 'Built-in project knowledge domain that captures the invisible knowledge layer around a codebase: architectural decisions and rationale, business logic semantics, design direction, and relationships between system components.'
    },

    search: {
      async expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
        if (!query.text) return query

        // Search for entity nodes matching query terms
        const entityTypes = ['module', 'data_entity', 'concept', 'pattern']
        const matchedEntityIds: string[] = []

        for (const type of entityTypes) {
          try {
            const results = await context.graph.query<Array<{ id: string }>>(
              `SELECT id FROM type::table($type) WHERE name CONTAINS $text LIMIT 5`,
              { type, text: query.text },
            )
            if (Array.isArray(results)) {
              matchedEntityIds.push(...results.map(r => r.id))
            }
          } catch {
            // Entity type may not exist yet
          }
        }

        if (matchedEntityIds.length === 0) return query

        // Add traversal hints to find memories linked to matched entities
        return {
          ...query,
          traversal: {
            from: matchedEntityIds,
            pattern: '<-about_entity<-memory',
            depth: 1,
          },
        }
      },
    },

    async buildContext(text: string, budgetTokens: number, context: DomainContext): Promise<ContextResult> {
      const empty: ContextResult = { context: '', memories: [], totalTokens: 0 }
      if (!text) return empty

      const audience = context.requestContext.audience as string | undefined

      const decisionBudget = Math.floor(budgetTokens * 0.5)
      const architectureBudget = Math.floor(budgetTokens * 0.3)
      const observationBudget = Math.floor(budgetTokens * 0.2)

      const allMemories: ScoredMemory[] = []
      const sections: string[] = []

      // Section 1 — [Decisions]: decisions and rationale
      for (const tag of [PROJECT_DECISION_TAG, PROJECT_RATIONALE_TAG]) {
        const result = await context.search({
          text,
          tags: [tag],
          tokenBudget: decisionBudget,
        })

        const entries = result.entries.filter(e => {
          const attrs = e.domainAttributes[PROJECT_DOMAIN_ID]
          if (attrs?.superseded) return false
          return matchesAudience(attrs, audience)
        })
        allMemories.push(...entries)
      }

      const decisionMemories = deduplicateMemories(allMemories)
      if (decisionMemories.length > 0) {
        const lines = truncateToTokenBudget(decisionMemories, decisionBudget)
        if (lines.length > 0) {
          sections.push(`[Decisions]\n${lines.join('\n')}`)
        }
      }

      // Section 2 — [Architecture]: entity-linked context via graph
      const archResult = await context.search({
        text,
        tags: [PROJECT_TAG],
        tokenBudget: architectureBudget,
      })
      const archEntries = archResult.entries.filter(e => {
        if (decisionMemories.some(d => d.id === e.id)) return false
        const attrs = e.domainAttributes[PROJECT_DOMAIN_ID]
        return matchesAudience(attrs, audience)
      })
      if (archEntries.length > 0) {
        const lines = truncateToTokenBudget(archEntries, architectureBudget)
        if (lines.length > 0) {
          sections.push(`[Architecture]\n${lines.join('\n')}`)
          allMemories.push(...archEntries)
        }
      }

      // Section 3 — [Recent Observations]: latest observations
      const obsResult = await context.search({
        text,
        tags: [PROJECT_OBSERVATION_TAG],
        tokenBudget: observationBudget,
      })
      if (obsResult.entries.length > 0) {
        const newObs = obsResult.entries.filter(e => {
          if (allMemories.some(m => m.id === e.id)) return false
          const attrs = e.domainAttributes[PROJECT_DOMAIN_ID]
          return matchesAudience(attrs, audience)
        })
        const lines = truncateToTokenBudget(newObs, observationBudget)
        if (lines.length > 0) {
          sections.push(`[Recent Observations]\n${lines.join('\n')}`)
          allMemories.push(...newObs)
        }
      }

      const finalContext = sections.join('\n\n')
      const totalTokens = countTokens(finalContext)

      return {
        context: finalContext,
        memories: deduplicateMemories(allMemories),
        totalTokens,
      }
    },
  }
}

/**
 * Checks if a memory's audience attribute includes the requested audience.
 * If no audience filter is requested, all memories match.
 */
function matchesAudience(
  attrs: Record<string, unknown> | undefined,
  requestedAudience: string | undefined,
): boolean {
  if (!requestedAudience) return true
  if (!attrs) return false
  const memAudience = attrs.audience
  if (Array.isArray(memAudience)) {
    return memAudience.includes(requestedAudience)
  }
  return memAudience === requestedAudience
}

function deduplicateMemories(memories: ScoredMemory[]): ScoredMemory[] {
  const seen = new Set<string>()
  const result: ScoredMemory[] = []
  for (const mem of memories) {
    if (!seen.has(mem.id)) {
      seen.add(mem.id)
      result.push(mem)
    }
  }
  return result
}

function truncateToTokenBudget(memories: ScoredMemory[], budget: number): string[] {
  const lines: string[] = []
  let tokens = 0
  for (const mem of memories) {
    const t = countTokens(mem.content)
    if (tokens + t > budget) break
    tokens += t
    lines.push(mem.content)
  }
  return lines
}

export const projectDomain = createProjectDomain()
