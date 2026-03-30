// Core
export { MemoryEngine } from './core/engine.ts'
export { GraphStore } from './core/graph-store.ts'
export { SchemaRegistry } from './core/schema-registry.ts'
export { SearchEngine } from './core/search-engine.ts'
export { InboxProcessor } from './core/inbox-processor.ts'
export { DomainRegistry } from './core/domain-registry.ts'
export { Scheduler } from './core/scheduler.ts'
export { EventEmitter } from './core/events.ts'

// Scoring utilities
export { computeDecay, countTokens, mergeScores, applyTokenBudget } from './core/scoring.ts'

// Types
export type {
  EngineConfig,
  GraphApi,
  Node,
  Edge,
  DomainConfig,
  DomainContext,
  DomainSchema,
  DomainSchedule,
  DomainSkill,
  DomainSettings,
  DomainSummary,
  WriteMemoryEntry,
  NodeDef,
  EdgeDef,
  FieldDef,
  IndexDef,
  MemoryFilter,
  SearchQuery,
  SearchResult,
  ScoredMemory,
  MemoryEntry,
  OwnedMemory,
  Tag,
  MemoryOwnership,
  Reference,
  ReferenceType,
  IngestOptions,
  IngestResult,
  RepetitionConfig,
  ContextOptions,
  ContextResult,
  AskOptions,
  AskResult,
  LLMAdapter,
  EmbeddingAdapter,
  MemoryEventName,
  RequestContext,
} from './core/types.ts'
export type { TopicAttributes, TopicDomainOptions, TopicStatus } from './domains/topic/types.ts'

// Domains
export { logDomain } from './domains/log-domain.ts'
export { createTopicDomain, topicDomain } from './domains/topic/index.ts'

// Adapters
export { ClaudeCliAdapter } from './adapters/llm/claude-cli.ts'

// Config
export { resolveConfigPath, loadConfig } from './config-loader.ts'
