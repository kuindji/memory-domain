import type { PgClient } from "../adapters/pg/types.js";
import { JsonbParam } from "../adapters/pg/types.js";
import { createPgClient } from "../adapters/pg/factory.js";
import { parseConnectionString } from "../adapters/pg/parse-connection.js";
import { GraphStore } from "./graph-store.js";
import { TunableParamRegistry } from "./tunable-params.js";
import type { TunableParamDefinition } from "./tunable-params.js";
import { SchemaRegistry } from "./schema-registry.js";
import { formatTagId, tagLabel } from "./tag-utils.js";
import { SearchEngine } from "./search-engine.js";
import { InboxProcessor } from "./inbox-processor.js";
import type { InboxProcessorOptions } from "./inbox-processor.js";
import { DomainRegistry } from "./domain-registry.js";
import { Scheduler, MetaScheduleStateStore } from "./scheduler.js";
import { EventEmitter } from "./events.js";
import { createDebugTools, wrapLLMAdapter } from "./debug.js";
import { countTokens, applyTokenBudget } from "./scoring.js";
import { loadPrompt as loadPromptFromFile } from "./prompt-loader.js";
import { parseArgs } from "../cli/parse-args.js";
import { dispatchCommand } from "../serve/dispatch.js";
import { createHash } from "node:crypto";
import type {
    EngineConfig,
    DomainConfig,
    DomainContext,
    IngestOptions,
    IngestResult,
    SearchQuery,
    SearchResult,
    MemoryEntry,
    LLMAdapter,
    EmbeddingAdapter,
    ContextOptions,
    ContextResult,
    AskOptions,
    AskResult,
    MemoryFilter,
    RepetitionConfig,
    WriteMemoryEntry,
    RequestContext,
    Edge,
    WriteOptions,
    WriteResult,
    UpdateOptions,
    ScheduleInfo,
    TraversalNode,
    ModelLevel,
    DomainRegistrationOptions,
    DebugConfig,
    DebugTools,
    ConnectionAdapter,
    TuneOptions,
    TuneResult,
    CoreMemory,
    OwnedMemory,
    DomainPlugin,
    DomainRegistration,
    FilterSpec,
    TableResult,
    TemplateParams,
    TemplateResult,
} from "./types.js";
import { isDomainRegistration } from "./types.js";

const ASK_ALLOWED_COMMANDS = [
    "search",
    "search-table",
    "run-template",
    "build-context",
    "memory",
    "domain",
    "domains",
    "skill",
    "core-memory",
] as const;

function askCacheKey(domainId: string, question: string, skill: string): string {
    const skillHash = createHash("sha256").update(skill).digest("hex").slice(0, 16);
    const questionHash = createHash("sha256").update(question).digest("hex").slice(0, 16);
    return `ask_cache_${domainId}_${skillHash}_${questionHash}`;
}

class MemoryEngine {
    private db: PgClient | null = null;
    private graph!: GraphStore;
    private schema!: SchemaRegistry;
    private searchEngine!: SearchEngine;
    private inboxProcessor!: InboxProcessor;
    private domainRegistry = new DomainRegistry();
    private scheduler!: Scheduler;
    private events = new EventEmitter();
    private llm!: LLMAdapter;
    private embedding?: EmbeddingAdapter;
    private repetitionConfig?: RepetitionConfig;
    private defaultContext: RequestContext = {};
    private adapter?: ConnectionAdapter;
    private debugConfig: DebugConfig = {};
    private debug!: DebugTools;
    private tunableParams: TunableParamRegistry = new TunableParamRegistry();
    private promptExtras: Record<string, string> = {};
    private pluginsByDomain = new Map<string, DomainPlugin[]>();
    private pluginRequirements = new Map<string, string[]>();

    async initialize(config: EngineConfig): Promise<void> {
        let dbConfig = config.db;
        if (!dbConfig && config.adapter) dbConfig = await config.adapter.resolve();
        if (!dbConfig && config.connection) dbConfig = parseConnectionString(config.connection);
        if (!dbConfig) {
            throw new Error(
                "EngineConfig requires one of: 'db', 'adapter', or 'connection' (legacy).",
            );
        }

        this.adapter = config.adapter;
        const db = await createPgClient(dbConfig);
        this.db = db;
        this.llm = config.llm;
        this.embedding = config.embedding;
        this.repetitionConfig = config.repetition;
        this.debugConfig = {
            timing: config.debug?.timing ?? process.env.MEMORY_DOMAIN_DEBUG_TIMING === "1",
        };
        this.debug = createDebugTools("engine", this.debugConfig);
        this.promptExtras = config.prompts ?? {};

        // Set up schema
        this.schema = new SchemaRegistry(db);

        // Prime lazy embedding adapters so `dimension` is populated before
        // schema-registry decides whether to define the HNSW index on memory.embedding.
        if (config.embedding && config.embedding.dimension === 0) {
            await config.embedding.embed("");
        }
        await this.schema.registerCore(config.embedding?.dimension);

        // Create inbox tag
        this.graph = new GraphStore(db, (table, column) =>
            this.schema.isJsonbColumn(table, column),
        );
        try {
            await this.graph.createNodeWithId("tag:inbox", {
                label: "inbox",
                created_at: Date.now(),
            });
        } catch {
            // Already exists — that's fine
        }

        // Initialize subsystems
        this.searchEngine = new SearchEngine(
            this.graph,
            config.search,
            config.embedding,
            createDebugTools("search", this.debugConfig),
        );
        const stateStore = new MetaScheduleStateStore(this.graph);
        this.scheduler = new Scheduler(
            (domainId: string) => this.createDomainContext(domainId),
            this.events,
            stateStore,
        );
        this.inboxProcessor = new InboxProcessor(
            this.graph,
            this.domainRegistry,
            this.events,
            (domainId: string, requestContext?: RequestContext) =>
                this.createDomainContext(domainId, requestContext),
            this.debugConfig,
        );

        this.defaultContext = config.context ?? {};
    }

    private validatePlugins(): void {
        for (const [domainId, required] of this.pluginRequirements) {
            const plugins = this.pluginsByDomain.get(domainId) ?? [];
            const availableTypes = new Set(plugins.map((p) => p.type));
            for (const req of required) {
                if (!availableTypes.has(req)) {
                    throw new Error(
                        `Domain "${domainId}" requires plugin type "${req}" but none is registered`,
                    );
                }
            }
        }
    }

    async registerDomain(
        input: DomainConfig | DomainRegistration,
        options?: DomainRegistrationOptions,
    ): Promise<void> {
        const registration: DomainRegistration = isDomainRegistration(input)
            ? input
            : { domain: input };
        const { domain, plugins, requires } = registration;
        let domainToRegister = domain;

        // Register schema if provided
        if (domain.schema) {
            await this.schema.registerDomain(domain.id, domain.schema);
        }

        // Create domain node in SurrealDB
        const domainData: Record<string, unknown> = { name: domain.name };
        if (domain.settings) {
            domainData.settings = domain.settings;
        }
        try {
            await this.graph.createNodeWithId(`domain:${domain.id}`, domainData);
        } catch {
            // Already exists — update settings if provided
            if (domain.settings) {
                await this.graph.updateNode(`domain:${domain.id}`, { settings: domain.settings });
            }
        }

        // Register schedules
        if (domain.schedules) {
            for (const schedule of domain.schedules) {
                this.scheduler.registerSchedule(domain.id, schedule);
            }
        }

        // Register tunable params and load persisted overrides
        if (domain.tunableParams) {
            this.tunableParams.register(domain.id, domain.tunableParams);
            const metaId = `meta:${domain.id}_tunable_params`;
            const node = await this.graph.getNode(metaId);
            if (node?.value) {
                try {
                    const persisted = JSON.parse(node.value as string) as Record<string, number>;
                    this.tunableParams.applyOverrides(domain.id, persisted);
                } catch {
                    // Ignore corrupt persisted values
                }
            }
        }

        // Register plugins
        if (plugins && plugins.length > 0) {
            // Wrap processInboxBatch if any plugin has afterInboxProcess
            if (plugins.some((p) => "afterInboxProcess" in p.hooks)) {
                const original = (entries: OwnedMemory[], context: DomainContext) =>
                    domain.processInboxBatch(entries, context);
                domainToRegister = Object.create(domain) as DomainConfig;
                domainToRegister.processInboxBatch = async (entries, context) => {
                    await original(entries, context);
                    // Fan out afterInboxProcess hooks in parallel. Each plugin
                    // owns a distinct corner of the graph (persona, topic,
                    // region, etc.); their writes to independent tables are
                    // safe to interleave. Plugins that create shared nodes
                    // (e.g. both touching `person:USA`) rely on the existing
                    // createNodeWithId + try/catch idempotency pattern, which
                    // already tolerates concurrent-creation races.
                    await Promise.all(
                        plugins
                            .filter((p) => p.hooks.afterInboxProcess !== undefined)
                            .map((p) => p.hooks.afterInboxProcess!(entries, context)),
                    );
                };
            }

            for (const plugin of plugins) {
                if (plugin.schema) {
                    await this.schema.registerDomain(
                        `${domain.id}:plugin:${plugin.type}`,
                        plugin.schema,
                    );
                }
                if (plugin.schedules) {
                    for (const schedule of plugin.schedules) {
                        this.scheduler.registerSchedule(domain.id, schedule);
                    }
                }
            }
            this.pluginsByDomain.set(domain.id, plugins);
        }
        if (requires && requires.length > 0) {
            this.pluginRequirements.set(domain.id, requires);
        }

        // Register in DomainRegistry (use wrapped domain if plugins modified it)
        this.domainRegistry.register(domainToRegister, options);
    }

    private assertWriteAccess(domainId: string): void {
        if (
            this.domainRegistry.has(domainId) &&
            this.domainRegistry.getAccess(domainId) === "read"
        ) {
            throw new Error(`Domain "${domainId}" is registered as read-only`);
        }
    }

    async writeMemory(text: string, options: WriteOptions): Promise<WriteResult> {
        this.assertWriteAccess(options.domain);
        const ctx = this.createDomainContext(options.domain, options.context);
        const id = await ctx.writeMemory({
            content: text,
            tags: options.tags,
            ownership: {
                domain: options.domain,
                attributes: options.attributes,
            },
        });
        // Remove inbox tag — writeMemory is direct, not inbox-processed
        await this.graph.unrelate(id, "tagged", "tag:inbox");
        return { id };
    }

    async getMemory(id: string): Promise<MemoryEntry | null> {
        const node = await this.graph.getNode(id);
        if (!node) return null;
        return {
            id: node.id,
            content: node.content as string,
            eventTime: (node.event_time as number | null) ?? null,
            createdAt: node.created_at as number,
            tokenCount: node.token_count as number,
        };
    }

    async updateMemory(id: string, options: UpdateOptions): Promise<void> {
        const node = await this.graph.getNode(id);
        if (!node) throw new Error(`Memory not found: ${id}`);

        if (options.text !== undefined) {
            const tokens = countTokens(options.text);
            const updates: Record<string, unknown> = {
                content: options.text,
                token_count: tokens,
            };
            if (this.embedding) {
                updates.embedding = await this.embedding.embed(options.text);
            }
            await this.graph.updateNode(id, updates);
        }

        if (options.attributes !== undefined) {
            const owners = await this.graph.query<{ out_id: string; attributes: unknown }>(
                `SELECT out_id, attributes FROM owned_by WHERE in_id = $1`,
                [id],
            );
            for (const owner of owners) {
                const existing =
                    owner.attributes && typeof owner.attributes === "object"
                        ? (owner.attributes as Record<string, unknown>)
                        : {};
                const merged = { ...existing, ...options.attributes };
                await this.graph.query(
                    `UPDATE owned_by SET attributes = $1 WHERE in_id = $2 AND out_id = $3`,
                    [new JsonbParam(merged), id, owner.out_id],
                );
            }
        }
    }

    async deleteMemory(id: string): Promise<void> {
        const node = await this.graph.getNode(id);
        if (!node) throw new Error(`Memory not found: ${id}`);

        const owners = await this.graph.query<{ out_id: string }>(
            `SELECT out_id FROM owned_by WHERE in_id = $1`,
            [id],
        );
        if (owners.length > 0) {
            for (const owner of owners) {
                const domainId = owner.out_id.replace(/^domain:/, "");
                await this.releaseOwnership(id, domainId);
            }
        } else {
            await this.graph.deleteNode(id);
        }
    }

    async tagMemory(id: string, tag: string): Promise<void> {
        const now = Date.now();
        const tagId = formatTagId(tag);
        const label = tagLabel(tag);
        try {
            await this.graph.createNodeWithId(tagId, { label, created_at: now });
        } catch {
            // Already exists
        }
        await this.graph.relate(id, "tagged", tagId);
    }

    async untagMemory(id: string, tag: string): Promise<void> {
        const tagId = formatTagId(tag);
        await this.graph.unrelate(id, "tagged", tagId);
    }

    async getMemoryTags(id: string): Promise<string[]> {
        const rows = await this.graph.query<{ label: string }>(
            `SELECT t.label FROM tagged tg
             JOIN tag t ON t.id = tg.out_id
             WHERE tg.in_id = $1`,
            [id],
        );
        return rows.map((r) => r.label);
    }

    async getEdges(
        nodeId: string,
        direction?: "in" | "out" | "both",
        domainId?: string,
    ): Promise<Edge[]> {
        if (domainId) {
            return this.createDomainContext(domainId).getNodeEdges(nodeId, direction);
        }

        const dir = direction ?? "both";
        const where =
            dir === "out"
                ? "in_id = $1"
                : dir === "in"
                  ? "out_id = $1"
                  : "in_id = $1 OR out_id = $1";

        const coreEdges = [
            "tagged",
            "owned_by",
            "reinforces",
            "contradicts",
            "summarizes",
            "refines",
            "child_of",
            "has_rule",
        ];
        const registeredEdges = this.schema.getRegisteredEdgeNames();
        const allEdges = [...new Set([...coreEdges, ...registeredEdges])];

        const results: Edge[] = [];
        for (const edgeName of allEdges) {
            const rows = await this.graph.query<Edge>(
                `SELECT *, in_id AS "in", out_id AS "out" FROM ${edgeName} WHERE ${where}`,
                [nodeId],
            );
            results.push(...rows);
        }
        return results;
    }

    // domainId is required by the CLI contract for audit/authorization context.
    // Access is enforced — read-only domains may not create edges.
    async relate(
        from: string,
        to: string,
        edgeType: string,
        domainId: string,
        attrs?: Record<string, unknown>,
    ): Promise<string> {
        this.assertWriteAccess(domainId);
        return this.graph.relate(from, edgeType, to, attrs);
    }

    async unrelate(from: string, to: string, edgeType: string): Promise<void> {
        await this.graph.unrelate(from, edgeType, to);
    }

    async traverse(
        startId: string,
        edgeTypes: string[],
        depth?: number,
        domainId?: string,
    ): Promise<TraversalNode[]> {
        const maxDepth = depth ?? 1;
        const visited = new Set<string>();
        visited.add(startId);

        const results: TraversalNode[] = [];
        let frontier: string[] = [startId];

        for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
            const nextFrontier: string[] = [];

            for (const nodeId of frontier) {
                for (const edgeType of edgeTypes) {
                    const querySource = domainId
                        ? this.createDomainContext(domainId).graph
                        : this.graph;
                    const rows = await querySource.query<{ out_id: string }>(
                        `SELECT out_id FROM ${edgeType} WHERE in_id = $1`,
                        [nodeId],
                    );
                    for (const row of rows) {
                        const outId = row.out_id;
                        if (!visited.has(outId)) {
                            visited.add(outId);
                            nextFrontier.push(outId);
                            results.push({ id: outId, depth: d, edge: edgeType, direction: "out" });
                        }
                    }
                }
            }

            frontier = nextFrontier;
        }

        return results;
    }

    // --- Core memory API ---

    private coreTagFor(domainId: string): string {
        return `core:${domainId}`;
    }

    private async queryCoreMemories(domainId: string): Promise<CoreMemory[]> {
        const coreTag = this.coreTagFor(domainId);
        const tagId = `tag:${coreTag}`;
        const rows = await this.graph.query<{
            id: string;
            content: string;
            created_at: number;
        }>(
            `SELECT m.id, m.content, m.created_at
             FROM tagged tg
             JOIN memory m ON m.id = tg.in_id
             WHERE tg.out_id = $1`,
            [tagId],
        );
        return rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.created_at }));
    }

    async addCoreMemory(domainId: string, content: string): Promise<string> {
        const domain = this.domainRegistry.get(domainId);
        if (!domain) throw new Error(`Domain "${domainId}" not found`);
        const coreTag = this.coreTagFor(domainId);
        const result = await this.writeMemory(content, {
            domain: domainId,
            tags: [coreTag],
        });
        return result.id;
    }

    async listCoreMemories(domainId: string): Promise<CoreMemory[]> {
        return this.queryCoreMemories(domainId);
    }

    async removeCoreMemory(domainId: string, id: string): Promise<void> {
        // Validate the memory has the core tag for this domain
        const coreTag = this.coreTagFor(domainId);
        const tags = await this.getMemoryTags(id);
        if (!tags.includes(coreTag)) {
            throw new Error(`Memory "${id}" is not a core memory for domain "${domainId}"`);
        }
        await this.deleteMemory(id);
    }

    listSchedules(domainId?: string): ScheduleInfo[] {
        return this.scheduler.listSchedules(domainId);
    }

    async triggerSchedule(domainId: string, scheduleId: string): Promise<void> {
        const schedules = this.scheduler.listSchedules(domainId);
        const found = schedules.find((s) => s.id === scheduleId);
        if (!found) {
            throw new Error(`Schedule not found: ${scheduleId} in domain ${domainId}`);
        }
        await this.scheduler.runNow(domainId, scheduleId);
    }

    async runDueSchedules(): Promise<{ ran: string[] }> {
        return this.scheduler.tickPersisted();
    }

    async ingest(text: string, options?: IngestOptions): Promise<IngestResult> {
        return this.debug.time(
            "ingest.total",
            async () => {
                const now = Date.now();
                const tokens = countTokens(text);

                // Generate embedding early (needed for dedup and storage)
                let embeddingVec: number[] | undefined;
                if (this.embedding) {
                    embeddingVec = await this.debug.time(
                        "ingest.embed",
                        () => this.embedding!.embed(text),
                        { chars: text.length },
                    );
                }

                // Dedup check
                if (!options?.skipDedup && embeddingVec && this.repetitionConfig) {
                    const vecLit = `[${embeddingVec.join(",")}]`;
                    const similar = await this.debug.time(
                        "ingest.dedupQuery",
                        () =>
                            this.graph.query<{ id: string; score: number }>(
                                `SELECT id, 1 - (embedding <=> $1::vector) AS score
                                 FROM memory
                                 WHERE embedding IS NOT NULL
                                 ORDER BY embedding <=> $1::vector ASC
                                 LIMIT 5`,
                                [vecLit],
                            ),
                        { chars: text.length },
                    );

                    if (similar.length > 0) {
                        const top = similar[0];
                        const existingId = top.id;

                        if (top.score >= this.repetitionConfig.duplicateThreshold) {
                            this.debug.log("ingest.skippedDuplicate", { existingId });
                            return { action: "skipped", existingId };
                        }

                        if (top.score >= this.repetitionConfig.reinforceThreshold) {
                            const memId = await this.debug.time(
                                "ingest.createMemoryNode",
                                () =>
                                    this.createMemoryNode(text, tokens, embeddingVec, options, now),
                                { mode: "reinforced" },
                            );
                            await this.graph.relate(memId, "reinforces", existingId, {
                                strength: top.score,
                                detected_at: now,
                            });
                            this.events.emit("reinforced", {
                                id: memId,
                                existingId,
                                similarity: top.score,
                            });
                            return { action: "reinforced", id: memId, existingId };
                        }
                    }
                }

                const memId = await this.debug.time(
                    "ingest.createMemoryNode",
                    () => this.createMemoryNode(text, tokens, embeddingVec, options, now),
                    { mode: "stored" },
                );
                return { action: "stored", id: memId };
            },
            {
                chars: text.length,
                domains: options?.domains?.length ?? 0,
                skipDedup: options?.skipDedup === true,
            },
        );
    }

    private async createMemoryNode(
        text: string,
        tokens: number,
        embeddingVec: number[] | undefined,
        options: IngestOptions | undefined,
        now: number,
    ): Promise<string> {
        const memData: Record<string, unknown> = {
            content: text,
            created_at: now,
            token_count: tokens,
        };
        if (options?.eventTime !== undefined) {
            memData.event_time = options.eventTime;
        }
        const requestContext = this.mergeContext(options?.context);
        if (Object.keys(requestContext).length > 0) {
            memData.request_context = requestContext;
        }
        if (embeddingVec) {
            memData.embedding = embeddingVec;
        }
        if (options?.structuredData) {
            memData.structured_data = options.structuredData;
        }
        if (options?.metadata && Object.keys(options.metadata).length > 0) {
            memData.metadata = options.metadata;
        }
        const memId = await this.graph.createNode("memory", memData);

        // Tag with inbox
        await this.graph.relate(memId, "tagged", "tag:inbox");

        // Add extra tags
        if (options?.tags && options.tags.length > 0) {
            await this.debug.time(
                "ingest.tagLoop",
                async () => {
                    for (const tag of options.tags!) {
                        const tagId = formatTagId(tag);
                        try {
                            await this.graph.createNodeWithId(tagId, {
                                label: tagLabel(tag),
                                created_at: now,
                            });
                        } catch {
                            // Already exists
                        }
                        await this.graph.relate(memId, "tagged", tagId);
                    }
                },
                { tags: options.tags.length },
            );
        }

        // Path A: Explicit domains specified — direct ownership + inbox processing tags
        if (options?.domains && options.domains.length > 0) {
            const targetDomainIds = options.domains.filter((id) => {
                if (!this.domainRegistry.has(id)) return true;
                return this.domainRegistry.getAccess(id) === "write";
            });

            // Add autoOwn domains not already in the list
            for (const domain of this.domainRegistry.list()) {
                if (
                    domain.settings?.autoOwn &&
                    !targetDomainIds.includes(domain.id) &&
                    this.domainRegistry.getAccess(domain.id) === "write"
                ) {
                    targetDomainIds.push(domain.id);
                }
            }

            if (targetDomainIds.length === 0) {
                throw new Error("Cannot ingest: all target domains are read-only");
            }

            await this.debug.time(
                "ingest.ownershipLoop.pathA",
                async () => {
                    for (const domainId of targetDomainIds) {
                        const fullDomainId = domainId.startsWith("domain:")
                            ? domainId
                            : `domain:${domainId}`;
                        await this.graph.relate(memId, "owned_by", fullDomainId, {
                            attributes: options?.metadata ?? {},
                            owned_at: now,
                        });
                        // Add inbox processing tag for this domain
                        const inboxTagId = await this.ensureInboxTag(`inbox:${domainId}`, now);
                        await this.graph.relate(memId, "tagged", inboxTagId);
                    }
                },
                { domains: targetDomainIds.length },
            );
        }
        // Path B: No explicit domains — assertion-based ownership
        else {
            await this.debug.time(
                "ingest.ownershipLoop.pathB",
                async () => {
                    let hasAnyTarget = false;

                    // autoOwn domains get direct ownership + inbox processing tags
                    for (const domain of this.domainRegistry.list()) {
                        if (
                            domain.settings?.autoOwn &&
                            this.domainRegistry.getAccess(domain.id) === "write"
                        ) {
                            const fullDomainId = `domain:${domain.id}`;
                            await this.graph.relate(memId, "owned_by", fullDomainId, {
                                attributes: options?.metadata ?? {},
                                owned_at: now,
                            });
                            const inboxTagId = await this.ensureInboxTag(`inbox:${domain.id}`, now);
                            await this.graph.relate(memId, "tagged", inboxTagId);
                            hasAnyTarget = true;
                        }
                    }

                    // Domains with assertInboxClaimBatch get assertion tags
                    for (const domain of this.domainRegistry.list()) {
                        if (
                            domain.assertInboxClaimBatch &&
                            !domain.settings?.autoOwn &&
                            this.domainRegistry.getAccess(domain.id) === "write"
                        ) {
                            const assertTagId = await this.ensureInboxTag(
                                `inbox:assert-claim:${domain.id}`,
                                now,
                            );
                            await this.inboxProcessor.ensureAssertClaimTagLinked(assertTagId);
                            await this.graph.relate(memId, "tagged", assertTagId);
                            hasAnyTarget = true;
                        }
                    }

                    if (!hasAnyTarget) {
                        throw new Error(
                            "Cannot ingest: no domains available (no explicit domain, no autoOwn, no assertInboxClaimBatch)",
                        );
                    }
                },
                { domains: this.domainRegistry.list().length },
            );
        }

        // Emit event
        this.events.emit("ingested", { id: memId, content: text, tokenCount: tokens });

        return memId;
    }

    private async ensureInboxTag(label: string, now: number): Promise<string> {
        const tagId = `tag:${label}`;
        try {
            await this.graph.createNodeWithId(tagId, { label, created_at: now });
        } catch {
            // Already exists
        }
        return tagId;
    }

    async search(query: SearchQuery): Promise<SearchResult> {
        // Let domains expand/rank the query
        let expandedQuery = query;
        const targetDomains = query.domains ?? this.domainRegistry.getAllDomainIds();

        for (const domainId of targetDomains) {
            const domain = this.domainRegistry.get(domainId);
            if (domain?.search?.expand) {
                const ctx = this.createDomainContext(domainId, query.context);
                expandedQuery = await domain.search.expand(expandedQuery, ctx);
            }
        }

        // Plugin search expansion (skippable for internal plugin-initiated searches)
        if (!query.skipPluginExpansion) {
            for (const domainId of targetDomains) {
                const domainPlugins = this.pluginsByDomain.get(domainId);
                if (domainPlugins) {
                    for (const plugin of domainPlugins) {
                        if (plugin.hooks.expandSearch) {
                            const ctx = this.createDomainContext(domainId, query.context);
                            expandedQuery = await plugin.hooks.expandSearch(expandedQuery, ctx);
                        }
                    }
                }
            }
        }

        let result = await this.searchEngine.search(expandedQuery);

        // Let domains rank results
        for (const domainId of targetDomains) {
            const domain = this.domainRegistry.get(domainId);
            if (domain?.search?.rank) {
                result = {
                    ...result,
                    entries: domain.search.rank(expandedQuery, result.entries),
                };
            }
        }

        return result;
    }

    async releaseOwnership(memoryId: string, domainId: string): Promise<void> {
        this.assertWriteAccess(domainId);
        const fullDomainId = domainId.startsWith("domain:") ? domainId : `domain:${domainId}`;

        // Remove owned_by edge
        await this.graph.unrelate(memoryId, "owned_by", fullDomainId);

        this.events.emit("ownershipRemoved", { memoryId, domainId });

        const remaining = await this.graph.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM owned_by WHERE in_id = $1`,
            [memoryId],
        );
        const count = remaining[0]?.count ?? 0;

        if (count === 0) {
            await this.graph.query(`DELETE FROM tagged WHERE in_id = $1`, [memoryId]);
            for (const edgeName of ["reinforces", "contradicts", "summarizes", "refines"]) {
                await this.graph.query(
                    `DELETE FROM ${edgeName} WHERE in_id = $1 OR out_id = $1`,
                    [memoryId],
                );
            }

            const coreEdges = new Set([
                "tagged",
                "owned_by",
                "reinforces",
                "contradicts",
                "summarizes",
                "refines",
                "child_of",
                "has_rule",
            ]);
            for (const edgeName of this.schema.getRegisteredEdgeNames()) {
                if (!coreEdges.has(edgeName)) {
                    await this.graph.query(
                        `DELETE FROM ${edgeName} WHERE in_id = $1 OR out_id = $1`,
                        [memoryId],
                    );
                }
            }

            await this.graph.deleteNode(memoryId);
            this.events.emit("deleted", { memoryId });
        }
    }

    private resolveVisibleDomains(domainId: string): string[] {
        const domain = this.domainRegistry.get(domainId);
        const allIds = this.domainRegistry.getAllDomainIds();
        const ensureSelf = (ids: string[]) => (ids.includes(domainId) ? ids : [domainId, ...ids]);

        if (!domain?.settings?.includeDomains && !domain?.settings?.excludeDomains) {
            return ensureSelf(allIds);
        }

        if (domain.settings.includeDomains) {
            const allowed = new Set(domain.settings.includeDomains);
            allowed.add(domainId);
            return allIds.filter((id) => allowed.has(id));
        }

        if (domain.settings.excludeDomains) {
            const blocked = new Set(domain.settings.excludeDomains);
            blocked.delete(domainId);
            return ensureSelf(allIds.filter((id) => !blocked.has(id)));
        }

        return ensureSelf(allIds);
    }

    private mergeContext(requestContext?: RequestContext): RequestContext {
        if (!requestContext) return { ...this.defaultContext };
        return { ...this.defaultContext, ...requestContext };
    }

    createDomainContext(domainId: string, requestContext?: RequestContext): DomainContext {
        const graph = this.graph;
        const baseLlm = this.llm;
        const embedding = this.embedding;
        const events = this.events;
        const visibleDomains = this.resolveVisibleDomains(domainId);
        const releaseOwnership = this.releaseOwnership.bind(this);
        const search = this.search.bind(this);
        const mergedContext = this.mergeContext(requestContext);
        const schema = this.schema;
        const domainRegistry = this.domainRegistry;
        const tunableParams = this.tunableParams;
        const promptExtras = this.promptExtras;
        const queryCoreMemsFn = this.queryCoreMemories.bind(this);
        let cachedCoreMemories: CoreMemory[] | null = null;
        const debug = createDebugTools(`domain:${domainId}`, this.debugConfig);
        const llm = wrapLLMAdapter(baseLlm, debug, "llm");

        async function isMemoryVisible(memoryId: string): Promise<boolean> {
            const owners = await graph.query<{ out_id: string }>(
                `SELECT out_id FROM owned_by WHERE in_id = $1`,
                [memoryId],
            );
            if (owners.length === 0) return false;
            return owners.some((o) =>
                visibleDomains.includes(o.out_id.replace(/^domain:/, "")),
            );
        }

        return {
            domain: domainId,
            graph,
            llm,
            llmAt(level: ModelLevel): LLMAdapter {
                const leveled = baseLlm.withLevel?.(level) ?? baseLlm;
                return wrapLLMAdapter(leveled, debug, `llm:${level}`);
            },
            debug,
            requestContext: mergedContext,

            getVisibleDomains(): string[] {
                return [...visibleDomains];
            },

            async getMemory(id: string): Promise<MemoryEntry | null> {
                const node = await graph.getNode(id);
                if (!node) return null;
                if (!(await isMemoryVisible(id))) return null;
                return {
                    id: node.id,
                    content: node.content as string,
                    eventTime: (node.event_time as number | null) ?? null,
                    createdAt: node.created_at as number,
                    tokenCount: node.token_count as number,
                };
            },

            async getMemories(filter?: MemoryFilter): Promise<MemoryEntry[]> {
                // Short-circuit: batch fetch by IDs
                if (filter?.ids) {
                    const results: MemoryEntry[] = [];
                    for (const id of filter.ids) {
                        const entry = await this.getMemory(id);
                        if (entry) results.push(entry);
                    }
                    return results;
                }

                const requestedDomains = filter?.domains ?? visibleDomains;
                const targetDomains = requestedDomains.filter((d) => visibleDomains.includes(d));
                const domainIds = targetDomains.map((d) =>
                    d.startsWith("domain:") ? d : `domain:${d}`,
                );

                const params: unknown[] = [domainIds];
                const where: string[] = [`out_id = ANY($1::text[])`];
                let pi = 2;

                if (filter?.since != null) {
                    where.push(`owned_at >= $${pi}`);
                    params.push(filter.since);
                    pi++;
                }

                if (filter?.attributes) {
                    for (const [key, value] of Object.entries(filter.attributes)) {
                        // jsonb path equality. attributes is jsonb; lookup key with ->>.
                        where.push(`attributes->>${"'" + key.replace(/'/g, "''") + "'"} = $${pi}`);
                        params.push(typeof value === "string" ? value : JSON.stringify(value));
                        pi++;
                    }
                }

                let limitClause = "";
                if (filter?.limit != null) {
                    limitClause = ` LIMIT $${pi}`;
                    params.push(filter.limit);
                    pi++;
                }

                const rows = await graph.query<{ in_id: string }>(
                    `SELECT in_id FROM owned_by WHERE ${where.join(" AND ")}${limitClause}`,
                    params,
                );
                let memoryIds = rows.map((r) => r.in_id);

                if (filter?.tags && filter.tags.length > 0) {
                    const tagIds = filter.tags.map((t) => (t.startsWith("tag:") ? t : `tag:${t}`));
                    const taggedRows = await graph.query<{ in_id: string }>(
                        `SELECT in_id FROM tagged
                         WHERE in_id = ANY($1::text[]) AND out_id = ANY($2::text[])`,
                        [memoryIds, tagIds],
                    );
                    const taggedIds = new Set(taggedRows.map((r) => r.in_id));
                    memoryIds = memoryIds.filter((id) => taggedIds.has(id));
                }

                const results: MemoryEntry[] = [];
                for (const id of memoryIds) {
                    const entry = await this.getMemory(id);
                    if (entry) results.push(entry);
                }
                return results;
            },

            async writeMemory(entry: WriteMemoryEntry): Promise<string> {
                const tokens = countTokens(entry.content);
                const now = Date.now();

                const memData: Record<string, unknown> = {
                    content: entry.content,
                    created_at: now,
                    token_count: tokens,
                };
                if (entry.eventTime !== undefined) {
                    memData.event_time = entry.eventTime;
                }
                if (embedding) {
                    memData.embedding = await embedding.embed(entry.content);
                }

                const memId = entry.id
                    ? await graph.createNodeWithId(entry.id, memData)
                    : await graph.createNode("memory", memData);

                if (entry.tags) {
                    for (const tag of entry.tags) {
                        await this.tagMemory(memId, tag);
                    }
                }

                if (entry.references) {
                    for (const ref of entry.references) {
                        await graph.relate(memId, ref.type, ref.targetId);
                    }
                }

                const ownerDomain = entry.ownership?.domain ?? domainId;
                await this.addOwnership(memId, ownerDomain, entry.ownership?.attributes);

                return memId;
            },

            async addTag(path: string): Promise<void> {
                const parts = path.split("/");
                let parentId: string | null = null;
                for (const part of parts) {
                    const tagId = `tag:${part}`;
                    try {
                        await graph.createNodeWithId(tagId, {
                            label: part,
                            created_at: Date.now(),
                        });
                    } catch {
                        // Already exists
                    }
                    if (parentId) {
                        await graph.relate(tagId, "child_of", parentId);
                    }
                    parentId = tagId;
                }
            },

            async tagMemory(memoryId: string, tagId: string): Promise<void> {
                const fullTagId = tagId.startsWith("tag:") ? tagId : `tag:${tagId}`;
                await graph.relate(memoryId, "tagged", fullTagId);
                events.emit("tagAssigned", { memoryId, tagId: fullTagId });
            },

            async untagMemory(memoryId: string, tagId: string): Promise<void> {
                const fullTagId = tagId.startsWith("tag:") ? tagId : `tag:${tagId}`;
                await graph.unrelate(memoryId, "tagged", fullTagId);
                events.emit("tagRemoved", { memoryId, tagId: fullTagId });
            },

            async getTagDescendants(tagPath: string): Promise<string[]> {
                const tagId = tagPath.startsWith("tag:") ? tagPath : `tag:${tagPath}`;
                const allDescendants = new Set<string>();
                let frontier = [tagId];

                for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
                    const children = await graph.query<{ in_id: string }>(
                        `SELECT in_id FROM child_of WHERE out_id = ANY($1::text[])`,
                        [frontier],
                    );
                    if (children.length === 0) break;
                    frontier = [];
                    for (const child of children) {
                        if (!allDescendants.has(child.in_id) && child.in_id !== tagId) {
                            allDescendants.add(child.in_id);
                            frontier.push(child.in_id);
                        }
                    }
                }
                return [...allDescendants];
            },

            async addOwnership(
                memoryId: string,
                targetDomainId: string,
                attributes?: Record<string, unknown>,
            ): Promise<void> {
                if (
                    domainRegistry.has(targetDomainId) &&
                    domainRegistry.getAccess(targetDomainId) === "read"
                ) {
                    throw new Error(`Domain "${targetDomainId}" is registered as read-only`);
                }
                const fullDomainId = targetDomainId.startsWith("domain:")
                    ? targetDomainId
                    : `domain:${targetDomainId}`;
                await graph.relate(memoryId, "owned_by", fullDomainId, {
                    attributes: attributes ?? {},
                    owned_at: Date.now(),
                });
                events.emit("ownershipAdded", { memoryId, domainId: targetDomainId });
            },

            async releaseOwnership(memoryId: string, targetDomainId: string): Promise<void> {
                await releaseOwnership(memoryId, targetDomainId);
            },

            async updateAttributes(
                memoryId: string,
                attributes: Record<string, unknown>,
            ): Promise<void> {
                const fullDomainId = domainId.startsWith("domain:")
                    ? domainId
                    : `domain:${domainId}`;
                await graph.query(
                    `UPDATE owned_by SET attributes = $1
                     WHERE in_id = $2 AND out_id = $3`,
                    [new JsonbParam(attributes), memoryId, fullDomainId],
                );
            },

            async search(query: Omit<SearchQuery, "domains">): Promise<SearchResult> {
                return search({ ...query, domains: visibleDomains });
            },

            async getMeta(key: string): Promise<string | null> {
                const metaId = `meta:${domainId}_${key}`;
                const node = await graph.getNode(metaId);
                if (!node) return null;
                return (node.value as string) ?? null;
            },

            async setMeta(key: string, value: string): Promise<void> {
                const metaId = `meta:${domainId}_${key}`;
                try {
                    await graph.createNodeWithId(metaId, { value });
                } catch {
                    await graph.updateNode(metaId, { value });
                }
            },

            getTunableParam(name: string): number | undefined {
                return tunableParams.get(domainId, name);
            },

            async getMemoryTags(memoryId: string): Promise<string[]> {
                if (!(await isMemoryVisible(memoryId))) return [];
                const rows = await graph.query<{ label: string }>(
                    `SELECT t.label FROM tagged tg
                     JOIN tag t ON t.id = tg.out_id
                     WHERE tg.in_id = $1`,
                    [memoryId],
                );
                return rows.map((r) => r.label);
            },

            async getNodeEdges(nodeId: string, direction?: "in" | "out" | "both"): Promise<Edge[]> {
                const dir = direction ?? "both";
                const where =
                    dir === "out"
                        ? "in_id = $1"
                        : dir === "in"
                          ? "out_id = $1"
                          : "in_id = $1 OR out_id = $1";

                const edgeNames = schema.getRegisteredEdgeNames();
                const coreEdges = [
                    "tagged",
                    "owned_by",
                    "reinforces",
                    "contradicts",
                    "summarizes",
                    "refines",
                    "child_of",
                    "has_rule",
                ];
                const allEdges = [...new Set([...coreEdges, ...edgeNames])];

                const results: Edge[] = [];
                for (const edgeName of allEdges) {
                    const rows = await graph.query<Edge>(
                        `SELECT *, in_id AS "in", out_id AS "out" FROM ${edgeName} WHERE ${where}`,
                        [nodeId],
                    );
                    results.push(...rows);
                }

                const filtered: Edge[] = [];
                for (const edge of results) {
                    const inId = String(edge.in);
                    const outId = String(edge.out);
                    const otherId = inId === nodeId ? outId : inId;
                    if (otherId.startsWith("memory:")) {
                        if (await isMemoryVisible(otherId)) filtered.push(edge);
                    } else {
                        filtered.push(edge);
                    }
                }

                return filtered;
            },

            async loadPrompt(name: string): Promise<string> {
                const domain = domainRegistry.get(domainId);
                if (!domain?.baseDir) {
                    throw new Error(
                        `Domain "${domainId}" has no baseDir — cannot load prompt "${name}"`,
                    );
                }
                const base = await loadPromptFromFile(domain.baseDir, name);
                const core = await this.getCoreMemories();
                const coreBlock = core.length > 0 ? core.map((m) => m.content).join("\n") : "";
                const extra = promptExtras[`${domainId}/${name}`];
                const parts = [base];
                if (coreBlock) parts.push(coreBlock);
                if (extra) parts.push(extra);
                return parts.join("\n\n");
            },

            async getCoreMemories(): Promise<CoreMemory[]> {
                if (cachedCoreMemories === null) {
                    cachedCoreMemories = await queryCoreMemsFn(domainId);
                }
                return cachedCoreMemories;
            },
        };
    }

    async buildContext(text: string, options?: ContextOptions): Promise<ContextResult> {
        const budgetTokens = options?.budgetTokens ?? 4000;
        const limit = options?.maxMemories ?? 50;

        // Check if a target domain has custom buildContext
        if (options?.domains?.length === 1) {
            const domainId = options.domains[0];
            const domain = this.domainRegistry.get(domainId);
            const hook = domain?.buildContext;
            if (hook) {
                const ctx = this.createDomainContext(domainId, options?.context);
                let result: ContextResult | undefined;
                if (typeof hook === "function") {
                    result = await hook(text, budgetTokens, ctx);
                } else if (typeof hook === "object" && hook.fromText) {
                    result = await hook.fromText(text, budgetTokens, ctx);
                }
                if (result) {
                    const domainPlugins = this.pluginsByDomain.get(domainId);
                    if (domainPlugins) {
                        for (const plugin of domainPlugins) {
                            if (plugin.hooks.enrichContext) {
                                result = await plugin.hooks.enrichContext(result, text, ctx);
                            }
                        }
                    }
                    return result;
                }
            }
        }

        // Search with hybrid mode
        const result = await this.search({
            text,
            limit,
            domains: options?.domains,
        });

        // Apply token budget
        const fitted = applyTokenBudget(
            result.entries.map((e) => ({ ...e, tokenCount: countTokens(e.content) })),
            budgetTokens,
        );

        // Format as numbered plain text
        const sections: string[] = [];

        // Prepend core memories if targeting a single domain
        if (options?.domains?.length === 1) {
            const ctx = this.createDomainContext(options.domains[0], options?.context);
            const core = await ctx.getCoreMemories();
            if (core.length > 0) {
                sections.push(`[Instructions]\n${core.map((m) => m.content).join("\n")}`);
            }
        }

        sections.push(fitted.map((m, i) => `[${i + 1}] ${m.content}`).join("\n\n"));

        const context = sections.join("\n\n");
        const totalTokens = countTokens(context);

        return { context, memories: fitted, totalTokens };
    }

    async runTemplate(
        domainId: string,
        name: string,
        params: TemplateParams,
        options?: { context?: RequestContext },
    ): Promise<TemplateResult> {
        const domain = this.domainRegistry.get(domainId);
        if (!domain) {
            throw new Error(`runTemplate: unknown domain "${domainId}"`);
        }
        const hook = domain.buildContext;
        if (!hook || typeof hook === "function" || !hook.templates) {
            throw new Error(
                `runTemplate: domain "${domainId}" has no templates registry (requested "${name}")`,
            );
        }
        const fn = hook.templates[name];
        if (!fn) {
            throw new Error(
                `runTemplate: domain "${domainId}" has no template named "${name}"`,
            );
        }
        const ctx = this.createDomainContext(domainId, options?.context);
        return fn(params, ctx);
    }

    async searchTable(
        domainId: string,
        filter: FilterSpec,
    ): Promise<TableResult> {
        const domain = this.domainRegistry.get(domainId);
        if (!domain) {
            throw new Error(`searchTable: unknown domain "${domainId}"`);
        }
        if (!domain.search?.execute) {
            throw new Error(
                `searchTable: domain "${domainId}" does not support tabular access (no search.execute defined)`,
            );
        }
        const ctx = this.createDomainContext(domainId);
        return await domain.search.execute(filter, ctx);
    }

    /** Public accessor for a domain's runtime context. Required by ingestion tooling that needs to write graph rows directly. */
    getDomainContext(domainId: string): DomainContext {
        const domain = this.domainRegistry.get(domainId);
        if (!domain) throw new Error(`getDomainContext: unknown domain "${domainId}"`);
        return this.createDomainContext(domainId);
    }

    async ask(question: string, options?: AskOptions): Promise<AskResult> {
        if (!options?.domains?.length || options.domains.length !== 1) {
            throw new Error(
                "ask() requires exactly one target domain via options.domains",
            );
        }
        const domainId = options.domains[0];

        const adapter = options?.effort && this.llm.withLevel
            ? this.llm.withLevel(options.effort)
            : this.llm;

        if (!adapter.runAgent) {
            throw new Error(
                "LLM adapter must implement runAgent() to use ask(). See ClaudeCliAdapter / OpenAiHttpAdapter.",
            );
        }

        const ctx = this.createDomainContext(domainId, options?.context);
        const skill = await ctx.loadPrompt("ask");

        const useCache = options?.cache !== false;
        const cacheKey = useCache ? askCacheKey(domainId, question, skill) : null;
        if (cacheKey) {
            const cachedRaw = await ctx.getMeta(cacheKey);
            if (cachedRaw) {
                try {
                    const cached = JSON.parse(cachedRaw) as AskResult;
                    return { ...cached, cached: true };
                } catch {
                    // Corrupt cache entry — ignore and recompute.
                }
            }
        }

        const toolExec = this.buildAskToolExec(domainId);
        const prevInnerEnv = process.env["MEMORY_DOMAIN_INNER_ASK"];
        process.env["MEMORY_DOMAIN_INNER_ASK"] = "1";
        let run;
        try {
            run = await adapter.runAgent({
                skill,
                question,
                toolExec,
                effort: options?.effort,
                budgetTokens: options?.budgetTokens,
                maxTurns: options?.maxTurns,
            });
        } finally {
            if (prevInnerEnv === undefined) {
                delete process.env["MEMORY_DOMAIN_INNER_ASK"];
            } else {
                process.env["MEMORY_DOMAIN_INNER_ASK"] = prevInnerEnv;
            }
        }

        const result: AskResult = {
            answer: run.answer,
            rounds: 1,
            turns: run.turns,
        };

        if (cacheKey) {
            try {
                await ctx.setMeta(cacheKey, JSON.stringify(result));
            } catch {
                // Persistence failure is non-fatal.
            }
        }

        return result;
    }

    private buildAskToolExec(
        _domainId: string,
    ): (call: { command: string; args: string[] }) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }> {
        return async (call) => {
            if (call.command !== "memory-domain") {
                return {
                    stdout: "",
                    stderr: `Only the 'memory-domain' CLI is available inside ask(); got '${call.command}'.`,
                    exitCode: 2,
                };
            }
            if (call.args[0] === "ask") {
                return {
                    stdout: "",
                    stderr:
                        "ask is not available inside ask(); answer from the data you already have.",
                    exitCode: 2,
                };
            }
            let parsed;
            try {
                parsed = parseArgs(call.args);
            } catch (err) {
                return {
                    stdout: "",
                    stderr: err instanceof Error ? err.message : String(err),
                    exitCode: 1,
                };
            }
            const result = await dispatchCommand(this, parsed, {
                pretty: true,
                allow: ASK_ALLOWED_COMMANDS,
            });
            if (result.ok) {
                return { stdout: result.rendered, stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: result.rendered, exitCode: result.exitCode };
        };
    }

    getGraph(): GraphStore {
        return this.graph;
    }

    getDomainRegistry(): DomainRegistry {
        return this.domainRegistry;
    }

    getEvents(): EventEmitter {
        return this.events;
    }

    /**
     * Verify that every registered table has its declared indexes defined in
     * SurrealDB. Returns a list of `<table>.<index_name>` identifiers that are
     * missing. Intended for debug mode / verification scripts — does not throw.
     */
    async verifyIndexes(): Promise<string[]> {
        return this.schema.verifyIndexes();
    }

    startProcessing(options?: InboxProcessorOptions): void {
        this.validatePlugins();
        this.inboxProcessor.start(options);
        this.scheduler.start();
    }

    stopProcessing(): void {
        this.inboxProcessor.stop();
        this.scheduler.stop();
    }

    async processInbox(): Promise<boolean> {
        return this.inboxProcessor.tick();
    }

    getBootstrappableDomains(): string[] {
        return this.domainRegistry
            .list()
            .filter((d) => d.bootstrap != null)
            .map((d) => d.id);
    }

    async runBootstrap(domainId?: string): Promise<string[]> {
        const domains = domainId
            ? [this.domainRegistry.getOrThrow(domainId)]
            : this.domainRegistry.list();

        const bootstrapped: string[] = [];
        for (const domain of domains) {
            const ctx = this.createDomainContext(domain.id);
            let ran = false;

            if (domain.bootstrap) {
                await domain.bootstrap(ctx);
                ran = true;
            }

            const domainPlugins = this.pluginsByDomain.get(domain.id);
            if (domainPlugins) {
                for (const plugin of domainPlugins) {
                    if (plugin.hooks.bootstrap) {
                        await plugin.hooks.bootstrap(ctx);
                        ran = true;
                    }
                }
            }

            if (ran) {
                bootstrapped.push(domain.id);
            }
        }
        return bootstrapped;
    }

    async saveTunableParams(domainId: string, values: Record<string, number>): Promise<void> {
        this.tunableParams.applyOverrides(domainId, values);
        const metaId = `meta:${domainId}_tunable_params`;
        const serialized = JSON.stringify(this.tunableParams.getAllForDomain(domainId));
        try {
            await this.graph.createNodeWithId(metaId, { value: serialized });
        } catch {
            await this.graph.updateNode(metaId, { value: serialized });
        }
    }

    getTunableParams(domainId: string): Record<string, number> {
        return this.tunableParams.getAllForDomain(domainId);
    }

    getTunableParamDefinitions(domainId: string): TunableParamDefinition[] {
        return this.tunableParams.getDefinitions(domainId);
    }

    async tune(
        domainId: string,
        evaluate: (params: Record<string, number>) => Promise<number>,
        options?: TuneOptions,
    ): Promise<TuneResult> {
        const maxIterations = options?.maxIterations ?? 50;
        const definitions = this.tunableParams.getDefinitions(domainId);
        if (definitions.length === 0) {
            throw new Error(`Domain "${domainId}" has no tunable parameters`);
        }

        let currentParams = { ...this.tunableParams.getAllForDomain(domainId) };
        let bestScore = await evaluate(currentParams);
        let bestParams = { ...currentParams };
        const history: TuneResult["history"] = [{ params: { ...currentParams }, score: bestScore }];

        for (let iter = 0; iter < maxIterations; iter++) {
            let improved = false;

            for (const def of definitions) {
                for (const direction of [1, -1]) {
                    const candidate = { ...currentParams };
                    const newVal = candidate[def.name] + direction * def.step;
                    candidate[def.name] = Math.max(def.min, Math.min(def.max, newVal));

                    if (candidate[def.name] === currentParams[def.name]) continue;

                    const score = await evaluate(candidate);
                    history.push({ params: { ...candidate }, score });

                    if (score > bestScore) {
                        bestScore = score;
                        bestParams = { ...candidate };
                        currentParams = { ...candidate };
                        improved = true;
                        break;
                    }
                }
                if (improved) break;
            }

            if (!improved) break;
        }

        await this.saveTunableParams(domainId, bestParams);

        return { bestParams, bestScore, iterations: history.length - 1, history };
    }

    getPlugins(domainId: string): DomainPlugin[] {
        return this.pluginsByDomain.get(domainId) ?? [];
    }

    async close(): Promise<void> {
        this.stopProcessing();
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
        if (this.adapter) {
            await this.adapter.save();
        }
    }
}

export { MemoryEngine };
