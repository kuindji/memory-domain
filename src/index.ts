// Core
export { MemoryEngine } from "./core/engine.js";
export { GraphStore } from "./core/graph-store.js";
export { SchemaRegistry } from "./core/schema-registry.js";
export { SearchEngine } from "./core/search-engine.js";
export { InboxProcessor } from "./core/inbox-processor.js";
export type { InboxProcessorOptions } from "./core/inbox-processor.js";
export { DomainRegistry } from "./core/domain-registry.js";
export { Scheduler } from "./core/scheduler.js";
export { EventEmitter } from "./core/events.js";

// Scoring utilities
export { computeDecay, countTokens, mergeScores, applyTokenBudget, cosineSimilarity } from "./core/scoring.js";
export type { TunableParamDefinition } from "./core/tunable-params.js";

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
    DomainRegistrationOptions,
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
    DebugConfig,
    DebugTools,
    MemoryEventName,
    RequestContext,
    WriteOptions,
    WriteResult,
    UpdateOptions,
    ScheduleInfo,
    TraversalNode,
    ModelLevel,
    ConnectionAdapter,
    S3AdapterConfig,
    CoreMemory,
} from "./core/types.js";
export type { TopicAttributes, TopicDomainOptions, TopicStatus } from "./domains/topic/types.js";
export type { UserDomainOptions } from "./domains/user/types.js";
export type {
    CodeRepoDomainOptions,
    MemoryClassification,
    Audience,
    ModuleKind,
    CodeRepoAttributes,
} from "./domains/code-repo/types.js";
export type { KbDomainOptions, KbClassification, KbAttributes } from "./domains/kb/types.js";

// Domains
export { logDomain } from "./domains/log-domain.js";
export { createTopicDomain, topicDomain } from "./domains/topic/index.js";
export { createUserDomain, userDomain } from "./domains/user/index.js";
export { createCodeRepoDomain, codeRepoDomain } from "./domains/code-repo/index.js";
export { createKbDomain, kbDomain } from "./domains/kb/index.js";

// Adapters
export { ClaudeCliAdapter } from "./adapters/llm/claude-cli.js";
export { BedrockAdapter } from "./adapters/llm/bedrock.js";
export type { BedrockAdapterConfig } from "./core/types.js";
export { OnnxEmbeddingAdapter } from "./adapters/onnx-embedding.js";
export type { OnnxEmbeddingConfig } from "./adapters/onnx-embedding.js";
export { PassthroughAdapter } from "./adapters/connection/passthrough.js";
export { S3ConnectionAdapter } from "./adapters/connection/s3.js";
export { FileConnectionAdapter } from "./adapters/connection/file.js";
export type { FileAdapterConfig } from "./adapters/connection/file.js";

// Config
export { resolveConfigPath, loadConfig } from "./config-loader.js";
