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
export {
    computeDecay,
    countTokens,
    mergeScores,
    applyTokenBudget,
    cosineSimilarity,
    cosineSimilarityF32,
} from "./core/scoring.js";
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
    FilterSpec,
    TableCell,
    TableRow,
    TableResult,
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
    TemplateResult,
    TemplateParams,
    TemplateFn,
    BuildContextApi,
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
    DomainPlugin,
    DomainPluginHooks,
    DomainRegistration,
} from "./core/types.js";
export { isDomainRegistration } from "./core/types.js";

// Domains
// NOTE: bundled framework domains (topic, user, code-repo, kb) and
// topic-linking plugin still hold raw SurrealQL after the Postgres
// migration and are not re-exported until they're rewritten in a
// follow-up cleanup pass. Only `logDomain` ships in this build.
export { logDomain } from "./domains/log-domain.js";

// Postgres adapter exports
export type { PgClient, DbConfig } from "./adapters/pg/types.js";
export { createPgClient, parseConnectionString } from "./adapters/pg/index.js";

// Adapters
export { ClaudeCliAdapter } from "./adapters/llm/claude-cli.js";
export { NoLlmAdapter } from "./adapters/llm/no-llm.js";
export { BedrockAdapter } from "./adapters/llm/bedrock.js";
export type { BedrockAdapterConfig } from "./core/types.js";
export { OpenAiHttpAdapter } from "./adapters/llm/openai-http.js";
export type { OpenAiHttpAdapterConfig } from "./adapters/llm/openai-http.js";
export { OnnxEmbeddingAdapter } from "./adapters/onnx-embedding.js";
export type { OnnxEmbeddingConfig } from "./adapters/onnx-embedding.js";
export { CachedEmbeddingAdapter } from "./adapters/cached-embedding.js";
export type { CachedEmbeddingOptions } from "./adapters/cached-embedding.js";
export { PassthroughAdapter } from "./adapters/connection/passthrough.js";
export { S3ConnectionAdapter } from "./adapters/connection/s3.js";
export { FileConnectionAdapter } from "./adapters/connection/file.js";
export type { FileAdapterConfig } from "./adapters/connection/file.js";
export { DirectoryConnectionAdapter } from "./adapters/connection/directory.js";
export type { DirectoryAdapterConfig } from "./adapters/connection/directory.js";

// Serve (transport adapters)
export { dispatchCommand, createLambdaAdapter, READ_ONLY_COMMANDS } from "./serve/index.js";
export type {
    DispatchResult,
    DispatchSuccess,
    DispatchFailure,
    DispatchOptions,
    LambdaInvocation,
    LambdaAdapterOptions,
    LambdaHandler,
} from "./serve/index.js";

// Config
export { resolveConfigPath, loadConfig } from "./config-loader.js";
