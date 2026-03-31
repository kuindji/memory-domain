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
  WriteOptions,
  WriteResult,
  UpdateOptions,
  ScheduleInfo,
  TraversalNode,
  ModelLevel,
} from './core/types.ts'
export type { TopicAttributes, TopicDomainOptions, TopicStatus } from './domains/topic/types.ts'
export type { UserDomainOptions } from './domains/user/types.ts'
export type { ProjectDomainOptions, MemoryClassification, Audience, ModuleKind, ProjectAttributes } from './domains/project/types.ts'

// Domains
export { logDomain } from './domains/log-domain.ts'
export { createTopicDomain, topicDomain } from './domains/topic/index.ts'
export { createUserDomain, userDomain } from './domains/user/index.ts'
export { createProjectDomain, projectDomain } from './domains/project/index.ts'

// Adapters
export { ClaudeCliAdapter } from './adapters/llm/claude-cli.ts'
export { OnnxEmbeddingAdapter } from './adapters/onnx-embedding.ts'
export type { OnnxEmbeddingConfig } from './adapters/onnx-embedding.ts'

// Config
export { resolveConfigPath, loadConfig } from './config-loader.ts'
