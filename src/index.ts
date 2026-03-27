// Core
export { MemoryEngine } from './core/engine.ts'
export { GraphStore } from './core/graph-store.ts'
export { SchemaRegistry } from './core/schema-registry.ts'
export { SearchEngine } from './core/search-engine.ts'
export { InboxProcessor } from './core/inbox-processor.ts'
export { DomainRegistry } from './core/domain-registry.ts'
export { Scheduler } from './core/scheduler.ts'
export { EventEmitter } from './core/events.ts'

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
  SharedSchema,
  NodeDef,
  EdgeDef,
  FieldDef,
  IndexDef,
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
  MemoryEventName,
} from './core/types.ts'

// Domains
export { logDomain } from './domains/log-domain.ts'

// Adapters
export { ClaudeCliAdapter } from './adapters/llm/claude-cli.ts'
