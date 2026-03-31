import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { DomainConfig, DomainSchedule, SearchQuery, DomainContext } from '../../core/types.ts'
import {
  CHAT_DOMAIN_ID,
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  DEFAULT_PRUNE_INTERVAL_MS,
} from './types.ts'
import type { ChatDomainOptions } from './types.ts'
import { chatSkills } from './skills.ts'
import { processInboxItem } from './inbox.ts'
import { promoteWorkingMemory, consolidateEpisodic, pruneDecayed } from './schedules.ts'

function buildSchedules(options?: ChatDomainOptions): DomainSchedule[] {
  const schedules: DomainSchedule[] = []

  if (options?.promoteSchedule?.enabled !== false) {
    schedules.push({
      id: 'promote-working-memory',
      name: 'Promote working memory',
      intervalMs: options?.promoteSchedule?.intervalMs ?? DEFAULT_PROMOTE_INTERVAL_MS,
      run: (context: DomainContext) => promoteWorkingMemory(context, options),
    })
  }

  if (options?.consolidateSchedule?.enabled !== false) {
    schedules.push({
      id: 'consolidate-episodic',
      name: 'Consolidate episodic memory',
      intervalMs: options?.consolidateSchedule?.intervalMs ?? DEFAULT_CONSOLIDATE_INTERVAL_MS,
      run: (context: DomainContext) => consolidateEpisodic(context, options),
    })
  }

  if (options?.pruneSchedule?.enabled !== false) {
    schedules.push({
      id: 'prune-decayed',
      name: 'Prune decayed memories',
      intervalMs: options?.pruneSchedule?.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
      run: (context: DomainContext) => pruneDecayed(context, options),
    })
  }

  return schedules
}

export function createChatDomain(options?: ChatDomainOptions): DomainConfig {
  return {
    id: CHAT_DOMAIN_ID,
    name: 'Chat',
    baseDir: dirname(fileURLToPath(import.meta.url)),
    schema: {
      nodes: [],
      edges: [
        { name: 'summarizes', from: 'memory', to: 'memory' },
      ],
    },
    skills: chatSkills,
    processInboxItem,
    schedules: buildSchedules(options),
    describe() {
      return 'Built-in conversational memory with tiered lifecycle. Stores raw messages as working memory, extracts highlights into episodic memory, and consolidates long-term knowledge into semantic memory.'
    },
    search: {
      expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
        const userId = context.requestContext.userId as string | undefined
        if (!userId) {
          return Promise.resolve({ ...query, ids: [] })
        }
        return Promise.resolve(query)
      },
    },
  }
}

export const chatDomain = createChatDomain()
