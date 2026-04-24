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

// Plugins
export { createTopicLinkingPlugin } from "./plugins/index.js";
export type { TopicLinkingOptions, ExtractedTopic, LinkResult } from "./plugins/index.js";

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
