export type TopicStatus = 'active' | 'stale' | 'merged'

export interface TopicAttributes {
  name: string
  status: TopicStatus
  mentionCount: number
  lastMentionedAt: number
  createdBy: string
  mergedInto?: string
}

export interface TopicDomainOptions {
  mergeSchedule?: {
    enabled?: boolean
    intervalMs?: number
  }
}

export const TOPIC_DOMAIN_ID = 'topic'
export const TOPIC_TAG = 'topic'
export const DEFAULT_MERGE_INTERVAL_MS = 3_600_000
export const MERGE_SIMILARITY_THRESHOLD = 0.85
