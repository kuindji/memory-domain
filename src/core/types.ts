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
    createNode(table: string, data: Record<string, unknown>): Promise<string>;
    createNodeWithId(id: string, data: Record<string, unknown>): Promise<string>;
    getNode<T extends Node = Node>(id: string): Promise<T | null>;
    getNodes<T extends Node = Node>(ids: string[]): Promise<T[]>;
    updateNode(id: string, data: Record<string, unknown>): Promise<void>;
    deleteNode(id: string): Promise<boolean>;
    deleteNodes(ids: string[]): Promise<void>;
    relate(from: string, edge: string, to: string, data?: Record<string, unknown>): Promise<string>;
    /**
     * Bulk-create N edges that share the same `to` node and the same `data`
     * payload. Collapses N round-trips to a single multi-row INSERT. Used on
     * inbox hot paths where a batch of memories all get tagged or owned by
     * the same target. Returns the generated edge ids in input order.
     */
    relateMany(
        fromIds: string[],
        edge: string,
        to: string,
        data?: Record<string, unknown>,
    ): Promise<string[]>;
    unrelate(from: string, edge: string, to: string): Promise<boolean>;
    outgoing<T = Edge>(from: string, edge: string): Promise<T[]>;
    incoming<T = Edge>(to: string, edge: string): Promise<T[]>;
    deleteEdges(
        edge: string,
        where: { in?: string | string[]; out?: string | string[] },
    ): Promise<void>;
    /** Raw SQL escape hatch — Postgres syntax with positional ($1, $2, ...) params. */
    query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
    /** Run a parameter-free statement (DDL etc.). */
    run(sql: string): Promise<void>;
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
    /** Filter to memories whose event_time is >= this timestamp (ms). Symmetric to beforeTime. */
    afterTime?: number;
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
    /**
     * Skip plugin-defined `expandSearch` hooks for this query.
     * Set by plugins that call `context.search` internally to avoid
     * recursive/quadratic expansion work. Domain-level `search.expand`
     * still runs.
     */
    skipPluginExpansion?: boolean;
    /**
     * Skip `enrichConnections` — do not populate `entry.connections`.
     * Use when the caller does not read the `connections` field.
     * Saves one (batched) query per search.
     */
    skipConnections?: boolean;
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

// --- Tabular access types (sibling to semantic search) ---

/** Opaque structured filter. Domains declare their own slot vocabulary; the
 *  framework never interprets this — it just hands it to `search.execute`. */
export interface FilterSpec {
    [slot: string]: unknown;
}

export type TableCell = string | number | boolean | null;

export interface TableRow {
    [column: string]: TableCell;
}

export interface TableResult {
    /** Stable-ordered rows. Domains MUST order deterministically. */
    rows: TableRow[];
    /** Column names in display order. Length > 0 even if rows is empty. */
    columns: string[];
    /** Domain-declared source identifier. */
    source: string;
    /** Optional per-row metadata (unit, source_ref, etc.) not shown in table. */
    rowMeta?: Record<string, unknown>[];
    /** Optional result-level metadata (dataWindow, version, etc.). */
    meta?: Record<string, unknown>;
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
    /** Optional explicit record id (e.g. "memory:usa-recession-2001"). When provided
     *  the node is created with that id so callers holding a stable identifier can
     *  short-circuit name/semantic dedup on subsequent writes. */
    id?: string;
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
        /** Deterministic tabular access. Returns rows for a structured filter.
         *  No LLM in the hot path; domains order results stably. */
        execute?(filter: FilterSpec, context: DomainContext): Promise<TableResult>;
    };
    buildContext?:
        | ((text: string, budgetTokens: number, context: DomainContext) => Promise<ContextResult>)
        | BuildContextApi;
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

export interface TemplateResult {
    /** Template name, for round-tripping and caching. */
    template: string;
    /** Stable-ordered rows. Templates MUST order deterministically. */
    rows: TableRow[];
    /** Column names in display order. */
    columns: string[];
    /** Domain source identifier. Matches TableResult.source. */
    source: string;
    /** Optional LLM-rendered paragraph. Populated only when caller requests it. */
    narrative?: string;
    /** Optional per-row metadata (unit, source_ref, etc.). */
    rowMeta?: Record<string, unknown>[];
    /** Optional result-level metadata (dataWindow, version, etc.). */
    meta?: Record<string, unknown>;
}

export interface TemplateParams {
    [key: string]: unknown;
    /** Opt-in narrative rendering. Default false. */
    narrative?: boolean;
}

export type TemplateFn = (
    params: TemplateParams,
    context: DomainContext,
) => Promise<TemplateResult>;

export interface BuildContextApi {
    fromText?(text: string, budgetTokens: number, context: DomainContext): Promise<ContextResult>;
    templates?: Record<string, TemplateFn>;
}

// --- Ask types ---

export interface AskOptions {
    domains?: string[];
    tags?: string[];
    budgetTokens?: number;
    limit?: number;
    maxRounds?: number;
    maxTurns?: number;
    effort?: ModelLevel;
    context?: RequestContext;
    cache?: boolean;
}

export interface AskResult {
    answer: string;
    rounds: number;
    turns?: AgentRunTurn[];
    cached?: boolean;
}

// --- Agent run types ---

export interface AgentToolCall {
    command: string;
    args: string[];
}

export interface AgentToolResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type AgentToolExec = (call: AgentToolCall) => Promise<AgentToolResult>;

export interface AgentRunSpec {
    skill: string;
    question: string;
    toolExec: AgentToolExec;
    effort?: ModelLevel;
    budgetTokens?: number;
    maxTurns?: number;
}

export interface AgentRunTurn {
    call: AgentToolCall;
    result: AgentToolResult;
}

export interface AgentRunResult {
    answer: string;
    turns: AgentRunTurn[];
}

// --- Adapter types ---

export interface LLMAdapter {
    // All methods are optional. NoLlmAdapter omits every method; callers
    // MUST gate every invocation on the method's presence
    // (`if (context.llm.extract) ...`) so that "LLM-free" code paths are
    // genuinely free of LLM calls instead of relying on try/catch to swallow
    // a thrown error after the fact.
    extract?(text: string, prompt?: string): Promise<string[]>;
    extractStructured?(text: string, schema: string, prompt?: string): Promise<unknown[]>;
    consolidate?(memories: string[]): Promise<string>;
    assess?(content: string, existingContext: string[]): Promise<number>;
    rerank?(query: string, candidates: { id: string; content: string }[]): Promise<string[]>;
    synthesize?(
        query: string,
        memories: ScoredMemory[],
        tagContext?: string[],
        instructions?: string,
    ): Promise<string>;
    generate?(prompt: string): Promise<string>;
    runAgent?(spec: AgentRunSpec): Promise<AgentRunResult>;
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
    /** Returns the database config the engine should connect with. */
    resolve(): Promise<import("../adapters/pg/types.js").DbConfig>;
    /** Persist the local data dir back to its origin (for tarball-backed adapters). */
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
    /** Postgres database config. Use `{ kind: 'pglite' }` for in-memory tests. */
    db?: import("../adapters/pg/types.js").DbConfig;
    /** Optional adapter that resolves to a DbConfig (e.g. file/s3/directory tarball stagers). Overrides `db` when present. */
    adapter?: ConnectionAdapter;
    /**
     * Legacy connection-string field parsed to DbConfig:
     *   `mem://` → in-memory PGLite
     *   `surrealkv://<path>` or `pglite://<path>` → file-backed PGLite at `<path>`
     *   `postgres://...` or `postgresql://...` → managed Postgres via Bun.SQL
     */
    connection?: string;
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
