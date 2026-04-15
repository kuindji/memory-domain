import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { StringRecordId } from "surrealdb";
import { loadPrompt } from "../core/prompt-loader.js";
import type {
    DomainPlugin,
    DomainContext,
    OwnedMemory,
    SearchQuery,
    GraphApi,
} from "../core/types.js";

/** A single extracted topic. The framework uses `name` for linking; `meta` is passed through to hooks. */
interface ExtractedTopic {
    /** The topic name used for search/create/match. */
    name: string;
    /** Arbitrary domain-specific metadata. Passed to afterTopicLink/afterAllTopicsLinked hooks. */
    meta?: Record<string, unknown>;
}

/** Result returned by linkSingleTopic for hook consumption. */
interface LinkResult {
    topicMemoryId: string;
    topic: ExtractedTopic;
    isNew: boolean;
}

interface TopicLinkingOptions {
    /** The domain ID that owns topic memories. Defaults to "topic". */
    topicDomainId?: string;
    /** The tag used to identify topic memories. Defaults to "topic". */
    topicTag?: string;
    /** Minimum similarity score for topic matching. Defaults to 0.8. */
    minScore?: number;
    /** Whether to denormalize topics onto memory records. Defaults to true. */
    denormalize?: boolean;

    /**
     * Replace the default batch extraction logic.
     * When provided, the default LLM extraction is skipped entirely.
     */
    extractTopics?: (
        entries: OwnedMemory[],
        context: DomainContext,
    ) => Promise<Map<string, ExtractedTopic[]>>;

    /**
     * Called after each topic memory is linked to a source memory.
     * Use to enrich the topic memory with additional attributes, tags, edges, etc.
     */
    afterTopicLink?: (
        topicMemoryId: string,
        topic: ExtractedTopic,
        sourceMemoryId: string,
        isNew: boolean,
        context: DomainContext,
    ) => Promise<void>;

    /**
     * Called once per source memory after all its topics have been linked.
     * Use for batch operations on the source memory (e.g., writing derived memories).
     */
    afterAllTopicsLinked?: (
        sourceMemory: OwnedMemory,
        linked: LinkResult[],
        context: DomainContext,
    ) => Promise<void>;

    /**
     * Called during plugin bootstrap, after the default bootstrap logic.
     * Use for tag seeding, one-time setup, etc.
     */
    onBootstrap?: (context: DomainContext) => Promise<void>;
}

const PLUGIN_BASE_DIR = dirname(fileURLToPath(import.meta.url));

/** Normalized key used for cache + indexed exact-match dedup of topic memories. */
function normalizeTopicName(name: string): string {
    return name.trim().toLowerCase();
}

const BATCH_TOPIC_EXTRACTION_SCHEMA = JSON.stringify({
    type: "array",
    items: {
        type: "object",
        properties: {
            index: { type: "number", description: "Zero-based index of the item" },
            topics: {
                type: "array",
                items: { type: "string" },
                description: "Topic names extracted from this item",
            },
        },
        required: ["index", "topics"],
    },
});

function createTopicLinkingPlugin(options?: TopicLinkingOptions): DomainPlugin {
    const topicDomainId = options?.topicDomainId ?? "topic";
    const topicTag = options?.topicTag ?? "topic";
    const minScore = options?.minScore ?? 0.8;
    const denormalize = options?.denormalize ?? true;

    /** Process-scoped cache: normalized topic name → { id, attrs }.
     *  Storing attrs alongside the id avoids a re-fetch on cache hit (updateAttributes
     *  replaces, not merges, so we need the prior snapshot to preserve non-counter fields). */
    interface CachedTopic {
        id: string;
        attrs: Record<string, unknown> | undefined;
    }
    const nameCache = new Map<string, CachedTopic>();

    async function linkSingleTopic(
        context: DomainContext,
        memoryId: string,
        topicName: string,
    ): Promise<{ topicMemoryId: string; isNew: boolean }> {
        return context.debug.time(
            "topicLinking.linkSingleTopic",
            () => linkSingleTopicImpl(context, memoryId, topicName),
            { chars: topicName.length },
        );
    }

    async function linkSingleTopicImpl(
        context: DomainContext,
        memoryId: string,
        topicName: string,
    ): Promise<{ topicMemoryId: string; isNew: boolean }> {
        const key = normalizeTopicName(topicName);

        // Tier A: process cache (normalized-name → {id, attrs}). Zero DB cost on hit.
        const cached = key ? nameCache.get(key) : undefined;
        let topicMemoryId: string | undefined = cached?.id;
        let existingAttrs: Record<string, unknown> | undefined = cached?.attrs;
        let isNew = false;

        // Tier B: indexed exact-match DB lookup on cache miss. O(log N) via idx_memory_name_normalized.
        // Also fetches existing domain attributes so the updateAttributes call below doesn't clobber them.
        if (!topicMemoryId && key) {
            const domainRef = new StringRecordId(`domain:${topicDomainId}`);
            topicMemoryId = await context.debug.time(
                "topicLinking.exactLookup",
                async () => {
                    try {
                        const rows = await context.graph.query<
                            Array<{ id: unknown; attrs?: Record<string, unknown> | null }>
                        >(
                            `SELECT id,
                                    (SELECT VALUE attributes FROM owned_by
                                       WHERE in = $parent.id AND out = $domainId)[0] AS attrs
                             FROM memory WHERE name_normalized = $key LIMIT 1`,
                            { key, domainId: domainRef },
                        );
                        const first = Array.isArray(rows) ? rows[0] : undefined;
                        if (!first?.id) return undefined;
                        if (first.attrs && typeof first.attrs === "object") {
                            existingAttrs = first.attrs;
                        }
                        return String(first.id);
                    } catch {
                        return undefined;
                    }
                },
                { chars: key.length },
            );
        }

        // Tier C (existing): similarity search — catches near-name matches the exact tiers miss.
        if (!topicMemoryId) {
            const searchResult = await context.debug.time(
                "topicLinking.dedupSearch",
                () =>
                    context.search({
                        text: topicName,
                        tags: [topicTag],
                        minScore,
                        skipPluginExpansion: true,
                        skipConnections: true,
                    }),
                { chars: topicName.length },
            );
            if (searchResult.entries.length > 0) {
                topicMemoryId = searchResult.entries[0].id;
                existingAttrs = searchResult.entries[0].domainAttributes[topicDomainId] as
                    | Record<string, unknown>
                    | undefined;
            }
        }

        if (topicMemoryId) {
            const currentCount = (existingAttrs?.mentionCount as number | undefined) ?? 0;
            const resolvedId = topicMemoryId;
            const nextAttrs: Record<string, unknown> = {
                ...existingAttrs,
                mentionCount: currentCount + 1,
                lastMentionedAt: Date.now(),
            };

            await context.debug.time(
                "topicLinking.updateAttributes",
                () => context.updateAttributes(resolvedId, nextAttrs),
            );
            // Keep cache in sync with the new on-disk attrs so the next hit preserves them too.
            existingAttrs = nextAttrs;
        } else {
            const seedAttrs: Record<string, unknown> = {
                name: topicName,
                status: "active",
                mentionCount: 1,
                lastMentionedAt: Date.now(),
                createdBy: context.domain,
            };
            topicMemoryId = await context.debug.time(
                "topicLinking.writeMemory",
                async () => {
                    const newId = await context.writeMemory({
                        content: topicName,
                        tags: [topicTag],
                        ownership: { domain: topicDomainId, attributes: seedAttrs },
                    });
                    if (key) {
                        // Populate denormalized exact-match field so tier B hits on next occurrence.
                        try {
                            await context.graph.query(
                                "UPDATE $id SET name_normalized = $key",
                                { id: new StringRecordId(newId), key },
                            );
                        } catch {
                            /* best-effort — next bootstrap backfill will catch it */
                        }
                    }
                    return newId;
                },
            );
            existingAttrs = seedAttrs;
            isNew = true;
        }

        if (key && topicMemoryId) {
            nameCache.set(key, { id: topicMemoryId, attrs: existingAttrs });
        }

        await context.debug.time("topicLinking.relateAboutTopic", () =>
            context.graph.relate(memoryId, "about_topic", topicMemoryId!, {
                domain: context.domain,
            }),
        );

        return { topicMemoryId: topicMemoryId!, isNew };
    }

    async function defaultExtractTopics(
        entries: OwnedMemory[],
        context: DomainContext,
    ): Promise<Map<string, ExtractedTopic[]>> {
        const result = new Map<string, ExtractedTopic[]>();
        const llm = context.llmAt("low");
        const topicPrompt = await loadPrompt(PLUGIN_BASE_DIR, "topic-extraction");

        const numberedItems = entries.map((e, i) => `${i}. ${e.memory.content}`).join("\n\n");

        if (llm.extractStructured) {
            try {
                const raw = (await llm.extractStructured(
                    numberedItems,
                    BATCH_TOPIC_EXTRACTION_SCHEMA,
                    topicPrompt,
                )) as Array<{ index: number; topics: string[] }>;

                for (const item of raw) {
                    if (
                        item.index >= 0 &&
                        item.index < entries.length &&
                        Array.isArray(item.topics)
                    ) {
                        result.set(
                            entries[item.index].memory.id,
                            item.topics.map((name) => ({ name })),
                        );
                    }
                }
                return result;
            } catch {
                // Fall through to sequential fallback
            }
        }

        for (const entry of entries) {
            try {
                const topics = await llm.extract(entry.memory.content);
                result.set(
                    entry.memory.id,
                    topics.map((name) => ({ name })),
                );
            } catch {
                result.set(entry.memory.id, []);
            }
        }

        return result;
    }

    async function linkToTopicsBatch(
        context: DomainContext,
        entries: OwnedMemory[],
    ): Promise<void> {
        const extract = options?.extractTopics ?? defaultExtractTopics;
        const topicsMap = await context.debug.time(
            "topicLinking.extract",
            () => extract(entries, context),
            { entries: entries.length },
        );

        for (const entry of entries) {
            const topics = topicsMap.get(entry.memory.id) ?? [];
            const linked: LinkResult[] = [];

            for (const topic of topics) {
                const trimmed = topic.name.trim();
                if (!trimmed) continue;

                const { topicMemoryId, isNew } = await linkSingleTopic(
                    context,
                    entry.memory.id,
                    trimmed,
                );

                if (options?.afterTopicLink) {
                    await context.debug.time(
                        "topicLinking.afterTopicLink",
                        () =>
                            options.afterTopicLink!(
                                topicMemoryId,
                                topic,
                                entry.memory.id,
                                isNew,
                                context,
                            ),
                        { isNew: isNew ? 1 : 0 },
                    );
                }

                linked.push({ topicMemoryId, topic, isNew });
            }

            if (options?.afterAllTopicsLinked && linked.length > 0) {
                await context.debug.time(
                    "topicLinking.afterAllTopicsLinked",
                    () => options.afterAllTopicsLinked!(entry, linked, context),
                    { linkedCount: linked.length },
                );
            }

            if (denormalize && linked.length > 0) {
                try {
                    const topicNames = linked.map((l) => l.topic.name);
                    await context.debug.time(
                        "topicLinking.denormalize",
                        () =>
                            context.graph.query("UPDATE $memId SET topics = $topics", {
                                memId: new StringRecordId(entry.memory.id),
                                topics: topicNames,
                            }),
                        { topicCount: topicNames.length },
                    );
                } catch {
                    /* best-effort denormalization */
                }
            }
        }
    }

    async function findMatchingTopicMemoryIds(text: string, graph: GraphApi): Promise<string[]> {
        try {
            const words = text
                .toLowerCase()
                .split(/\s+/)
                .filter((w) => w.length > 3);
            if (words.length === 0) return [];

            const topicTagId = new StringRecordId(`tag:${topicTag}`);
            const results = await graph.query<Array<{ id: string; content: string }>>(
                `SELECT in as id, (SELECT content FROM ONLY $parent.in).content as content FROM tagged WHERE out = $tagId`,
                { tagId: topicTagId },
            );
            if (!Array.isArray(results) || results.length === 0) return [];

            return results
                .filter((r) => {
                    const content = (r.content ?? "").toLowerCase();
                    return words.some((w) => content.includes(w));
                })
                .map((r) => String(r.id));
        } catch {
            return [];
        }
    }

    return {
        type: "topic-linking",

        schema: {
            nodes: [
                {
                    name: "memory",
                    fields: [{ name: "name_normalized", type: "option<string>" }],
                    indexes: [
                        {
                            name: "idx_memory_name_normalized",
                            fields: ["name_normalized"],
                        },
                    ],
                },
            ],
            edges: [
                {
                    name: "about_topic",
                    from: "memory",
                    to: "memory",
                    fields: [{ name: "domain", type: "string" }],
                },
            ],
        },

        hooks: {
            async afterInboxProcess(entries: OwnedMemory[], context: DomainContext): Promise<void> {
                await linkToTopicsBatch(context, entries);
            },

            async expandSearch(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
                if (!query.text) return query;
                try {
                    const topicIds = await context.debug.time(
                        "topicLinking.findMatchingTopicMemoryIds",
                        () => findMatchingTopicMemoryIds(query.text!, context.graph),
                        { chars: query.text.length },
                    );
                    if (topicIds.length === 0) return query;
                    return {
                        ...query,
                        traversal: {
                            from: topicIds,
                            pattern: "<-about_topic<-memory.*",
                            depth: 1,
                        },
                    };
                } catch {
                    return query;
                }
            },

            async bootstrap(context: DomainContext): Promise<void> {
                // One-time backfill: populate name_normalized on existing topic memories so tier B
                // (indexed exact-match) can find them on first occurrence in a new process. Idempotent
                // via the IS NONE guard — later runs are no-ops.
                try {
                    const topicTagRef = new StringRecordId(`tag:${topicTag}`);
                    await context.graph.query(
                        `UPDATE (SELECT VALUE in FROM tagged WHERE out = $tagId)
                         SET name_normalized = string::lowercase(string::trim(content))
                         WHERE name_normalized IS NONE`,
                        { tagId: topicTagRef },
                    );
                } catch {
                    /* best-effort — missing field just means tier B misses on legacy rows */
                }

                if (denormalize) {
                    const domainRef = new StringRecordId(`domain:${context.domain}`);
                    const rows = await context.graph.query<
                        Array<{ in: string; attributes: Record<string, unknown> }>
                    >(
                        `SELECT in, attributes FROM owned_by WHERE out = $domainId AND in.topics IS NONE`,
                        { domainId: domainRef },
                    );

                    if (rows && rows.length > 0) {
                        for (const row of rows) {
                            const topicRows = await context.graph.query<Array<{ content: string }>>(
                                `SELECT (SELECT content FROM ONLY $parent.out).content AS content FROM about_topic WHERE in = $memId`,
                                { memId: new StringRecordId(row.in) },
                            );
                            if (topicRows && topicRows.length > 0) {
                                const topics = topicRows
                                    .map((t) => t.content)
                                    .filter((c) => typeof c === "string" && c.length > 0);
                                if (topics.length > 0) {
                                    await context.graph.query(
                                        "UPDATE $memId SET topics = $topics",
                                        {
                                            memId: new StringRecordId(row.in),
                                            topics,
                                        },
                                    );
                                }
                            }
                        }
                    }
                }

                if (options?.onBootstrap) {
                    await options.onBootstrap(context);
                }
            },
        },
    };
}

export type { TopicLinkingOptions, ExtractedTopic, LinkResult };
export { createTopicLinkingPlugin };
