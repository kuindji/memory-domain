import type { TunableParamDefinition } from "./tunable-params.js";

// --- Core entity types ---

export interface MemoryEntry {
    id: string;
    content: string;
    embedding?: number[];
    eventTime: number | null;
    createdAt: number;
    tokenCount: number;
}

export interface Tag {
    id: string;
    label: string;
    createdAt: number;
}

export interface MemoryOwnership {
    memoryId: string;
    domain: string;
    attributes: Record<string, unknown>;
    ownedAt: number;
}

export type ReferenceType = "reinforces" | "contradicts" | "summarizes" | "refines";

export interface Reference {
    targetId: string;
    type: ReferenceType;
}

// --- Graph types ---

export interface Node {
    id: string;
    [key: string]: unknown;
}

export interface Edge {
    id: string;
    in: string;
    out: string;
    [key: string]: unknown;
}

export interface GraphApi {
    createNode(type: string, data: Record<string, unknown>): Promise<string>;
    createNodeWithId(id: string, data: Record<string, unknown>): Promise<string>;
    getNode<T extends Node = Node>(id: string): Promise<T | null>;
    updateNode(id: string, data: Record<string, unknown>): Promise<void>;
    deleteNode(id: string): Promise<boolean>;
    relate(from: string, edge: string, to: string, data?: Record<string, unknown>): Promise<string>;
    unrelate(from: string, edge: string, to: string): Promise<boolean>;
    traverse<T = Node>(from: string, pattern: string): Promise<T[]>;
    query<T = unknown>(surql: string, vars?: Record<string, unknown>): Promise<T>;
    transaction<T>(fn: (tx: GraphApi) => Promise<T>): Promise<T>;
}

// --- Schema types ---

export interface FieldDef {
    name: string;
    type: string;
    required?: boolean;
    default?: string | number | boolean | null;
    computed?: string;
}

export interface IndexDef {
    name: string;
    fields: string[];
    type?: "unique" | "search" | "hnsw";
    config?: Record<string, unknown>;
    condition?: string;
}

export interface NodeDef {
    name: string;
    fields: FieldDef[];
    indexes?: IndexDef[];
    schemafull?: boolean;
}

export interface EdgeDef {
    name: string;
    from: string | string[];
    to: string | string[];
    fields?: FieldDef[];
}

export interface DomainSchema {
    nodes: NodeDef[];
    edges: EdgeDef[];
}

// --- Filter & search types ---

export interface MemoryFilter {
    ids?: string[];
    tags?: string[];
    domains?: string[];
    attributes?: Record<string, unknown>;
    since?: number;
    /** Filter to memories whose event_time is <= this timestamp (ms). Lets callers freeze the clock for historical queries. */
    beforeTime?: number;
    limit?: number;
}

export interface SearchQuery extends MemoryFilter {
    text?: string;
    mode?: "vector" | "fulltext" | "hybrid" | "graph";
    traversal?: {
        from: string | string[];
        pattern: string;
        depth?: number;
    };
    tokenBudget?: number;
    minScore?: number;
    weights?: {
        vector?: number;
        fulltext?: number;
        graph?: number;
    };
    context?: RequestContext;
    rerank?: boolean;
    rerankThreshold?: number;
    filters?: Record<string, unknown>;
}

export interface SearchResult {
    entries: ScoredMemory[];
    totalTokens: number;
    mode: string;
    stats?: {
        vectorCandidates?: number;
        fulltextCandidates?: number;
        graphCandidates?: number;
        mergedTotal: number;
    };
}

export interface ScoredMemory {
    id: string;
    content: string;
    score: number;
    scores: {
        vector?: number;
        fulltext?: number;
        graph?: number;
    };
    tags: string[];
    domainAttributes: Record<string, Record<string, unknown>>;
    eventTime: number | null;
    createdAt: number;
    tokenCount?: number;
    connections?: {
        references?: { id: string; type: string }[];
    };
}

// --- Core memory types ---

export interface CoreMemory {
    id: string;
    content: string;
    createdAt: number;
}

// --- Model level types ---

export type ModelLevel = "low" | "medium" | "high";

export interface DebugConfig {
    timing?: boolean;
}

export interface DebugTools {
    timingEnabled: boolean;
    log(label: string, details?: Record<string, unknown>): void;
    time<T>(label: string, fn: () => Promise<T>, details?: Record<string, unknown>): Promise<T>;
}

// --- Domain types ---

export interface OwnedMemory {
    memory: MemoryEntry;
    domainAttributes: Record<string, unknown>;
    tags: string[];
    /** Domain-specific slice of pre-extracted structured data, if provided at ingest time. */
    structuredData?: unknown;
}

export interface WriteMemoryEntry {
    content: string;
    eventTime?: number | null;
    tags?: string[];
    references?: Reference[];
    ownership?: {
        domain: string;
        attributes?: Record<string, unknown>;
    };
}

export interface DomainContext {
    domain: string;
    graph: GraphApi;
    llm: LLMAdapter;
    llmAt(level: ModelLevel): LLMAdapter;
    debug: DebugTools;
    getVisibleDomains(): string[];
    getMemory(id: string): Promise<MemoryEntry | null>;
    getMemories(filter?: MemoryFilter): Promise<MemoryEntry[]>;
    writeMemory(entry: WriteMemoryEntry): Promise<string>;
    addTag(path: string): Promise<void>;
    tagMemory(memoryId: string, tagId: string): Promise<void>;
    untagMemory(memoryId: string, tagId: string): Promise<void>;
    getTagDescendants(tagPath: string): Promise<string[]>;
    addOwnership(
        memoryId: string,
        domainId: string,
        attributes?: Record<string, unknown>,
    ): Promise<void>;
    releaseOwnership(memoryId: string, domainId: string): Promise<void>;
    updateAttributes(memoryId: string, attributes: Record<string, unknown>): Promise<void>;
    search(query: Omit<SearchQuery, "domains">): Promise<SearchResult>;
    getMeta(key: string): Promise<string | null>;
    setMeta(key: string, value: string): Promise<void>;
    getTunableParam(name: string): number | undefined;
    requestContext: RequestContext;
    getMemoryTags(memoryId: string): Promise<string[]>;
    getNodeEdges(nodeId: string, direction?: "in" | "out" | "both"): Promise<Edge[]>;
    loadPrompt(name: string): Promise<string>;
    getCoreMemories(): Promise<CoreMemory[]>;
}

export interface DomainSchedule {
    id: string;
    name: string;
    intervalMs: number;
    run: (context: DomainContext) => Promise<void>;
}

export interface DomainSkill {
    id: string;
    name: string;
    description: string;
    scope: "internal" | "external" | "both";
    writes?: boolean;
}

export interface DomainSettings {
    includeDomains?: string[];
    excludeDomains?: string[];
    autoOwn?: boolean;
}

export interface DomainRegistrationOptions {
    access?: "read" | "write";
}

export interface DomainSummary {
    id: string;
    name: string;
    description?: string;
    hasStructure: boolean;
    skillCount: number;
}

export interface DomainConfig {
    id: string;
    name: string;
    baseDir?: string;
    schema?: DomainSchema;
    skills?: DomainSkill[];
    settings?: DomainSettings;
    processInboxBatch(entries: OwnedMemory[], context: DomainContext): Promise<void>;
    assertInboxClaimBatch?(entries: OwnedMemory[], context: DomainContext): Promise<string[]>;
    search?: {
        rank?(query: SearchQuery, candidates: ScoredMemory[]): ScoredMemory[];
        expand?(query: SearchQuery, context: DomainContext): Promise<SearchQuery>;
    };
    buildContext?(
        text: string,
        budgetTokens: number,
        context: DomainContext,
    ): Promise<ContextResult>;
    describe?(): string;
    schedules?: DomainSchedule[];
    tunableParams?: TunableParamDefinition[];
    bootstrap?(context: DomainContext): Promise<void>;
}

// --- Ingestion types ---

export interface IngestOptions {
    domains?: string[];
    eventTime?: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
    skipDedup?: boolean;
    context?: RequestContext;
    /** Pre-extracted structured data keyed by domain ID. Passed through to organizers
     *  so they can skip LLM extraction when structured data is available. */
    structuredData?: Record<string, unknown>;
}

export interface IngestResult {
    action: "stored" | "reinforced" | "skipped";
    id?: string;
    existingId?: string;
}

export interface RepetitionConfig {
    duplicateThreshold: number;
    reinforceThreshold: number;
}

// --- Context building types ---

export interface ContextOptions {
    domains?: string[];
    budgetTokens?: number;
    maxMemories?: number;
    context?: RequestContext;
}

export interface ContextResult {
    context: string;
    memories: ScoredMemory[];
    totalTokens: number;
}

// --- Ask types ---

export interface AskOptions {
    domains?: string[];
    tags?: string[];
    budgetTokens?: number;
    limit?: number;
    maxRounds?: number;
    context?: RequestContext;
}

export interface AskResult {
    answer: string;
    memories: ScoredMemory[];
    rounds: number;
}

// --- Adapter types ---

export interface LLMAdapter {
    extract(text: string, prompt?: string): Promise<string[]>;
    extractStructured?(text: string, schema: string, prompt?: string): Promise<unknown[]>;
    consolidate(memories: string[]): Promise<string>;
    assess?(content: string, existingContext: string[]): Promise<number>;
    rerank?(query: string, candidates: { id: string; content: string }[]): Promise<string[]>;
    synthesize?(
        query: string,
        memories: ScoredMemory[],
        tagContext?: string[],
        instructions?: string,
    ): Promise<string>;
    generate?(prompt: string): Promise<string>;
    withLevel?(level: ModelLevel): LLMAdapter;
}

// --- Embedding adapter ---

export interface EmbeddingAdapter {
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    readonly dimension: number;
}

// --- Connection adapter types ---

export interface ConnectionAdapter {
    resolve(): Promise<string>;
    save(): Promise<void>;
}

export interface S3AdapterConfig {
    bucket: string;
    key: string;
    region: string;
    localDir?: string;
    save?: boolean;
    profile?: string;
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
    };
}

export interface BedrockAdapterConfig {
    modelId: string;
    region: string;
    modelLevels?: Partial<Record<ModelLevel, string>>;
    maxTokens?: number;
    timeout?: number;
    profile?: string;
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
    };
}

// --- Config types ---

export interface EngineConfig {
    connection?: string;
    adapter?: ConnectionAdapter;
    namespace?: string;
    database?: string;
    credentials?: { user: string; pass: string };
    llm: LLMAdapter;
    embedding?: EmbeddingAdapter;
    repetition?: RepetitionConfig;
    search?: {
        defaultMode?: "vector" | "fulltext" | "hybrid";
        defaultWeights?: { vector?: number; fulltext?: number; graph?: number };
        defaultEf?: number;
    };
    context?: RequestContext;
    debug?: DebugConfig;
    /** Additional text appended to domain prompts. Keys are "domainId/promptName". */
    prompts?: Record<string, string>;
}

// --- Event types ---

export type MemoryEventName =
    | "ingested"
    | "deleted"
    | "reinforced"
    | "tagAssigned"
    | "tagRemoved"
    | "ownershipAdded"
    | "ownershipRemoved"
    | "inboxProcessed"
    | "inboxClaimAsserted"
    | "inboxDomainProcessed"
    | "scheduleRun"
    | "error"
    | "warning";

// --- Request context ---

export type RequestContext = Record<string, unknown>;

// --- Engine API types ---

export interface WriteOptions {
    domain: string;
    tags?: string[];
    attributes?: Record<string, unknown>;
    context?: RequestContext;
}

export interface WriteResult {
    id: string;
}

export interface UpdateOptions {
    attributes?: Record<string, unknown>;
    text?: string;
}

export interface ScheduleInfo {
    id: string;
    domain: string;
    name: string;
    interval: number;
    lastRun?: number;
}

export interface TraversalNode {
    id: string;
    depth: number;
    edge: string;
    direction: "in" | "out";
    memory?: ScoredMemory;
}

export interface TuneOptions {
    maxIterations?: number;
}

export interface TuneResult {
    bestParams: Record<string, number>;
    bestScore: number;
    iterations: number;
    history: Array<{ params: Record<string, number>; score: number }>;
}

export type { DomainPlugin, DomainPluginHooks, DomainRegistration } from "./plugin-types.js";
export { isDomainRegistration } from "./plugin-types.js";
