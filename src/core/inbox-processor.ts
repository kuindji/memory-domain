import { createHash } from "node:crypto";
import { createDebugTools } from "./debug.js";
import { cosineSimilarityF32 } from "./scoring.js";
import type { GraphStore } from "./graph-store.js";
import type { DomainRegistry } from "./domain-registry.js";
import type { EventEmitter } from "./events.js";
import type {
    DebugConfig,
    DebugTools,
    DomainContext,
    OwnedMemory,
    MemoryEntry,
    Node,
} from "./types.js";

interface RawMemoryRow {
    id: string;
    content: string;
    embedding?: number[] | string | null;
    event_time: number | null;
    created_at: number;
    token_count: number;
    request_context?: Record<string, unknown>;
    structured_data?: Record<string, unknown>;
}

interface InboxLockPayload {
    lockedAt: number;
}

type InboxStage = "assert" | "process";
type FailureKind = "transient" | "permanent" | "unknown";
type FailureStatus = "retryable_failed" | "quarantined";

interface BatchFailureRecord {
    stage: InboxStage;
    domainId: string;
    memoryIds: string[];
    requestContext?: Record<string, unknown>;
    attempt: number;
    status: FailureStatus;
    failureKind: FailureKind;
    errorName?: string;
    errorMessage: string;
    firstAttemptAt: number;
    lastAttemptAt: number;
}

interface InboxProcessorOptions {
    intervalMs?: number;
    batchLimit?: number;
    staleAfterMs?: number;
    similarityThreshold?: number;
}

interface SimilarityBatch {
    batchId: string;
    entries: OwnedMemory[];
    memoryIds: string[];
    requestContext?: Record<string, unknown>;
}

type TagFilter = { type: "assert-claim" } | { type: "domain"; domainId: string };

const PROCESSING_ROOT_LABEL = "inbox:processing:_root";
const PROCESSING_ROOT_TAG_ID = `tag:${PROCESSING_ROOT_LABEL}`;

const ASSERT_CLAIM_ROOT_LABEL = "inbox:assert-claim:_root";
const ASSERT_CLAIM_ROOT_TAG_ID = `tag:${ASSERT_CLAIM_ROOT_LABEL}`;

function parseEmbedding(raw: number[] | string | null | undefined): number[] | undefined {
    if (raw == null) return undefined;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string" && raw.startsWith("[")) {
        try {
            return JSON.parse(raw) as number[];
        } catch {
            return undefined;
        }
    }
    return undefined;
}

class InboxProcessor {
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private intervalMs = 5000;
    private batchLimit = 50;
    private staleAfterMs = 30_000;
    private similarityThreshold = 0;
    private maxTransientAttempts = 2;
    private debug: DebugTools;

    constructor(
        private store: GraphStore,
        private domainRegistry: DomainRegistry,
        private events: EventEmitter,
        private contextFactory: (
            domainId: string,
            requestContext?: Record<string, unknown>,
        ) => DomainContext,
        debugConfig?: DebugConfig,
    ) {
        this.debug = createDebugTools("inbox", debugConfig);
    }

    // --- Stale Batch Recovery ---

    private async recoverStaleBatches(): Promise<void> {
        const cutoff = Date.now() - this.staleAfterMs;
        const staleTags = await this.store.query<{ in_id: string }>(
            `SELECT c.in_id FROM child_of c
             JOIN tag t ON t.id = c.in_id
             WHERE c.out_id = $1 AND t.created_at < $2`,
            [PROCESSING_ROOT_TAG_ID, cutoff],
        );
        if (staleTags.length === 0) return;

        const staleTagIds = staleTags.map((r) => r.in_id);
        await this.store.query(`DELETE FROM tagged WHERE out_id = ANY($1::text[])`, [staleTagIds]);
        await this.store.query(
            `DELETE FROM child_of WHERE in_id = ANY($1::text[]) AND out_id = $2`,
            [staleTagIds, PROCESSING_ROOT_TAG_ID],
        );
        await this.store.deleteNodes(staleTagIds);
    }

    // --- Candidate Fetching ---

    private async fetchCandidateIds(filter: TagFilter): Promise<string[]> {
        const candidates = await this.debug.time(
            "buildSimilarityBatch.fetchInboxTagged",
            async () => {
                if (filter.type === "assert-claim") {
                    const tagRows = await this.store.query<{ in_id: string }>(
                        `SELECT in_id FROM child_of WHERE out_id = $1`,
                        [ASSERT_CLAIM_ROOT_TAG_ID],
                    );
                    if (tagRows.length === 0) return [];
                    const tagIds = tagRows.map((r) => r.in_id);
                    return this.store.query<{ in_id: string }>(
                        `SELECT in_id FROM tagged WHERE out_id = ANY($1::text[])`,
                        [tagIds],
                    );
                }
                return this.store.query<{ in_id: string }>(
                    `SELECT in_id FROM tagged WHERE out_id = $1`,
                    [`tag:inbox:${filter.domainId}`],
                );
            },
            { filter: filter.type },
        );
        if (candidates.length === 0) return [];

        const memIds = [...new Set(candidates.map((r) => r.in_id))];

        const processingIds = await this.debug.time(
            "buildSimilarityBatch.fetchProcessing",
            async () => {
                const procTagRows = await this.store.query<{ in_id: string }>(
                    `SELECT in_id FROM child_of WHERE out_id = $1`,
                    [PROCESSING_ROOT_TAG_ID],
                );
                if (procTagRows.length === 0) return new Set<string>();
                const procTagIds = procTagRows.map((r) => r.in_id);
                const taggedRows = await this.store.query<{ in_id: string }>(
                    `SELECT in_id FROM tagged WHERE out_id = ANY($1::text[])`,
                    [procTagIds],
                );
                return new Set(taggedRows.map((r) => r.in_id));
            },
        );

        return memIds.filter((id) => !processingIds.has(id));
    }

    private async fetchMemoryRows(ids: string[]): Promise<RawMemoryRow[]> {
        if (ids.length === 0) return [];

        const nodes = await Promise.all(
            ids.map((id) =>
                this.store.query<RawMemoryRow>(
                    `SELECT id, content, embedding::text AS embedding,
                            event_time, created_at, token_count,
                            request_context, structured_data
                     FROM memory WHERE id = $1`,
                    [id],
                ),
            ),
        );
        const rows: RawMemoryRow[] = [];
        for (const result of nodes) {
            const node = result[0];
            if (!node) continue;
            rows.push({
                id: node.id,
                content: node.content,
                embedding: parseEmbedding(node.embedding),
                event_time: node.event_time,
                created_at: node.created_at,
                token_count: node.token_count,
                request_context: this.normalizeRequestContext(node.request_context),
            });
        }
        return rows;
    }

    // --- Similarity Batch Building ---

    private buildSimilarityBatch(
        filter: TagFilter,
        domainId?: string,
    ): Promise<SimilarityBatch | null> {
        return this.debug.time(
            "buildSimilarityBatch",
            () => this.buildSimilarityBatchImpl(filter, domainId),
            { domain: domainId ?? "none" },
        );
    }

    private async buildSimilarityBatchImpl(
        filter: TagFilter,
        domainId?: string,
    ): Promise<SimilarityBatch | null> {
        const candidateIds = await this.debug.time(
            "buildSimilarityBatch.fetchCandidateIds",
            () => this.fetchCandidateIds(filter),
            { filter: filter.type },
        );
        if (candidateIds.length === 0) return null;

        const candidateRows = await this.debug.time(
            "buildSimilarityBatch.fetchMemoryRows",
            () => this.fetchMemoryRows(candidateIds),
            { candidates: candidateIds.length },
        );
        if (candidateRows.length === 0) return null;
        candidateRows.sort((a, b) => a.created_at - b.created_at);

        const seed = candidateRows[0];
        const seedId = seed.id;
        const requestContext = seed.request_context;
        const requestContextKey = this.getRequestContextKey(requestContext);
        const sameContextRows = candidateRows.filter(
            (row) => this.getRequestContextKey(row.request_context) === requestContextKey,
        );

        let batchIds: string[];
        const seedEmbedding = parseEmbedding(seed.embedding);
        if (seedEmbedding && sameContextRows.length > 1) {
            const candidateRowsSansSeed = sameContextRows.slice(1);
            batchIds = await this.debug.time(
                "buildSimilarityBatch.findSimilarNeighbors",
                () =>
                    this.findSimilarNeighbors(
                        { ...seed, embedding: seedEmbedding },
                        candidateRowsSansSeed,
                    ),
                { neighbors: candidateRowsSansSeed.length },
            );
            batchIds = [seedId, ...batchIds];
        } else {
            batchIds = sameContextRows.slice(0, this.batchLimit).map((r) => r.id);
        }

        const batchId = await this.debug.time(
            "buildSimilarityBatch.tagBatchAsProcessing",
            () => this.tagBatchAsProcessing(batchIds),
            { batchSize: batchIds.length },
        );

        const entries = await this.debug.time(
            "buildSimilarityBatch.buildOwnedMemoryEntries",
            () => this.buildOwnedMemoryEntries(batchIds, domainId),
            { batchSize: batchIds.length },
        );

        return { batchId, entries, memoryIds: batchIds, requestContext };
    }

    private async findSimilarNeighbors(
        seed: RawMemoryRow & { embedding: number[] },
        candidateRows: RawMemoryRow[],
    ): Promise<string[]> {
        if (candidateRows.length === 0) return [];
        const seedId = seed.id;
        const limit = this.batchLimit - 1;
        const threshold = this.similarityThreshold > 0 ? this.similarityThreshold : null;

        const seedF32 = Float32Array.from(seed.embedding);
        const seedLen = seedF32.length;

        const scored: Array<{ id: string; similarity: number }> = [];
        const withoutEmbedding: string[] = [];

        for (const row of candidateRows) {
            const rowId = row.id;
            if (rowId === seedId) continue;
            const emb = parseEmbedding(row.embedding);
            if (!emb || emb.length !== seedLen) {
                withoutEmbedding.push(rowId);
                continue;
            }
            const similarity = cosineSimilarityF32(seedF32, Float32Array.from(emb));
            if (threshold !== null && similarity < threshold) continue;
            scored.push({ id: rowId, similarity });
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        const similarIds = scored.slice(0, limit).map((s) => s.id);
        const spotsLeft = limit - similarIds.length;
        if (spotsLeft > 0) similarIds.push(...withoutEmbedding.slice(0, spotsLeft));
        return similarIds;
    }

    private normalizeRequestContext(value: unknown): Record<string, unknown> | undefined {
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        return value as Record<string, unknown>;
    }

    private getRequestContextKey(requestContext: Record<string, unknown> | undefined): string {
        if (!requestContext) return "";
        return this.stableStringify(requestContext);
    }

    private stableStringify(value: unknown): string {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;
        }
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([l], [r]) => l.localeCompare(r));
        return `{${entries
            .map(([k, v]) => `${JSON.stringify(k)}:${this.stableStringify(v)}`)
            .join(",")}}`;
    }

    private classifyError(error: unknown): FailureKind {
        const message = this.getErrorMessage(error).toLowerCase();
        const name = error instanceof Error ? error.name.toLowerCase() : "";

        const transientMarkers = [
            "timeout",
            "timed out",
            "rate limit",
            "too many requests",
            "temporarily unavailable",
            "service unavailable",
            "gateway timeout",
            "bad gateway",
            "connection reset",
            "connection refused",
            "socket hang up",
            "network",
            "econnreset",
            "econnrefused",
            "etimedout",
            "eai_again",
            "429",
            "503",
            "504",
            "overloaded",
        ];
        if (name === "aborterror" || transientMarkers.some((m) => message.includes(m))) {
            return "transient";
        }
        return error instanceof Error ? "permanent" : "unknown";
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error && error.message) return error.message;
        if (typeof error === "string") return error;
        return "Unknown inbox processing failure";
    }

    private getBatchMetaId(
        stage: InboxStage,
        domainId: string,
        memoryIds: string[],
        requestContext?: Record<string, unknown>,
    ): string {
        const payload = this.stableStringify({
            stage,
            domainId,
            memoryIds: [...memoryIds].sort(),
            requestContextKey: this.getRequestContextKey(requestContext),
        });
        const hash = createHash("sha256").update(payload).digest("hex").slice(0, 24);
        return `meta:inbox_batch_${hash}`;
    }

    private async readBatchFailureRecord(metaId: string): Promise<BatchFailureRecord | null> {
        const node = await this.store.getNode<Node & { value?: string }>(metaId);
        if (!node?.value) return null;
        try {
            const parsed: unknown = JSON.parse(node.value);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
            return parsed as BatchFailureRecord;
        } catch {
            return null;
        }
    }

    private async clearBatchFailureRecord(
        stage: InboxStage,
        domainId: string,
        memoryIds: string[],
        requestContext?: Record<string, unknown>,
    ): Promise<void> {
        const metaId = this.getBatchMetaId(stage, domainId, memoryIds, requestContext);
        try {
            await this.store.deleteNode(metaId);
        } catch {
            /* best-effort */
        }
    }

    private async recordBatchFailure(
        stage: InboxStage,
        domainId: string,
        memoryIds: string[],
        requestContext: Record<string, unknown> | undefined,
        error: unknown,
    ): Promise<BatchFailureRecord> {
        const metaId = this.getBatchMetaId(stage, domainId, memoryIds, requestContext);
        const existing = await this.readBatchFailureRecord(metaId);
        const now = Date.now();
        const failureKind = this.classifyError(error);
        const attempt = (existing?.attempt ?? 0) + 1;
        const status: FailureStatus =
            failureKind === "transient" && attempt < this.maxTransientAttempts
                ? "retryable_failed"
                : "quarantined";

        const record: BatchFailureRecord = {
            stage,
            domainId,
            memoryIds: [...memoryIds].sort(),
            requestContext,
            attempt,
            status,
            failureKind,
            errorName: error instanceof Error ? error.name : undefined,
            errorMessage: this.getErrorMessage(error),
            firstAttemptAt: existing?.firstAttemptAt ?? now,
            lastAttemptAt: now,
        };

        const value = JSON.stringify(record);
        try {
            await this.store.createNodeWithId(metaId, { value });
        } catch {
            await this.store.updateNode(metaId, { value });
        }
        return record;
    }

    private async ensureTag(label: string): Promise<string> {
        const tagId = `tag:${label}`;
        try {
            await this.store.createNodeWithId(tagId, { label, created_at: Date.now() });
        } catch {
            /* already exists */
        }
        return tagId;
    }

    private async countActiveInboxTags(memId: string): Promise<number> {
        const rows = await this.store.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
             FROM tagged tg JOIN tag t ON t.id = tg.out_id
             WHERE tg.in_id = $1
               AND t.label LIKE 'inbox:%'
               AND t.label NOT LIKE 'inbox:processing:%'
               AND t.label NOT LIKE 'inbox:failed%'`,
            [memId],
        );
        return rows[0]?.count ?? 0;
    }

    private async clearRootInboxIfNoActiveTags(memId: string): Promise<void> {
        const remaining = await this.countActiveInboxTags(memId);
        if (remaining === 0) {
            await this.store.unrelate(memId, "tagged", "tag:inbox");
            await this.store.query(`UPDATE memory SET structured_data = NULL WHERE id = $1`, [
                memId,
            ]);
            this.events.emit("inboxProcessed", { memoryId: memId });
        }
    }

    private async countTagsByPrefix(memId: string, prefix: string): Promise<number> {
        const rows = await this.store.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
             FROM tagged tg JOIN tag t ON t.id = tg.out_id
             WHERE tg.in_id = $1 AND t.label LIKE $2`,
            [memId, `${prefix}%`],
        );
        return rows[0]?.count ?? 0;
    }

    private async tagBatchAsProcessing(memoryIds: string[]): Promise<string> {
        const batchId = crypto.randomUUID();
        const label = `inbox:processing:${batchId}`;
        const tagId = `tag:${label}`;
        const now = Date.now();

        await this.ensureProcessingRoot();
        await this.store.createNodeWithId(tagId, { label, created_at: now });
        await this.store.relate(tagId, "child_of", PROCESSING_ROOT_TAG_ID);

        await Promise.all(
            memoryIds.map((memId) => this.store.relate(memId, "tagged", tagId)),
        );
        return batchId;
    }

    private async removeBatchProcessingTag(batchId: string): Promise<void> {
        const tagId = `tag:inbox:processing:${batchId}`;
        await this.store.query(`DELETE FROM tagged WHERE out_id = $1`, [tagId]);
        await this.store.query(
            `DELETE FROM child_of WHERE in_id = $1 AND out_id = $2`,
            [tagId, PROCESSING_ROOT_TAG_ID],
        );
        try {
            await this.store.deleteNode(tagId);
        } catch {
            /* best-effort */
        }
    }

    private processingRootReady = false;
    private async ensureProcessingRoot(): Promise<void> {
        if (this.processingRootReady) return;
        try {
            await this.store.createNodeWithId(PROCESSING_ROOT_TAG_ID, {
                label: PROCESSING_ROOT_LABEL,
                created_at: Date.now(),
            });
        } catch {
            /* already exists */
        }
        this.processingRootReady = true;
    }

    private assertClaimRootReady = false;
    private assertClaimBackfilled = false;
    private readonly assertClaimLinked = new Set<string>();

    private async ensureAssertClaimRoot(): Promise<void> {
        if (this.assertClaimRootReady) return;
        try {
            await this.store.createNodeWithId(ASSERT_CLAIM_ROOT_TAG_ID, {
                label: ASSERT_CLAIM_ROOT_LABEL,
                created_at: Date.now(),
            });
        } catch {
            /* already exists */
        }
        this.assertClaimRootReady = true;
    }

    async ensureAssertClaimTagLinked(tagId: string): Promise<void> {
        if (this.assertClaimLinked.has(tagId)) return;
        await this.ensureAssertClaimRoot();
        await this.store.relate(tagId, "child_of", ASSERT_CLAIM_ROOT_TAG_ID);
        this.assertClaimLinked.add(tagId);
    }

    private async backfillAssertClaimLinks(): Promise<void> {
        if (this.assertClaimBackfilled) return;
        await this.ensureAssertClaimRoot();
        const linkedRows = await this.store.query<{ in_id: string }>(
            `SELECT in_id FROM child_of WHERE out_id = $1`,
            [ASSERT_CLAIM_ROOT_TAG_ID],
        );
        for (const row of linkedRows) this.assertClaimLinked.add(row.in_id);

        const tagRows = await this.store.query<{ id: string }>(
            `SELECT id FROM tag WHERE label LIKE 'inbox:assert-claim:%' AND label != $1`,
            [ASSERT_CLAIM_ROOT_LABEL],
        );
        for (const row of tagRows) {
            const tagId = row.id;
            if (!this.assertClaimLinked.has(tagId)) {
                await this.store.relate(tagId, "child_of", ASSERT_CLAIM_ROOT_TAG_ID);
                this.assertClaimLinked.add(tagId);
            }
        }
        this.assertClaimBackfilled = true;
    }

    private toMemoryEntry(raw: RawMemoryRow): MemoryEntry {
        return {
            id: raw.id,
            content: raw.content,
            eventTime: raw.event_time,
            createdAt: raw.created_at,
            tokenCount: raw.token_count,
        };
    }

    private async buildOwnedMemoryEntries(
        memoryIds: string[],
        domainId?: string,
    ): Promise<OwnedMemory[]> {
        if (memoryIds.length === 0) return [];

        const perMemory = await Promise.all(
            memoryIds.map(async (memId): Promise<OwnedMemory | null> => {
                const targetDomainId = domainId ? `domain:${domainId}` : null;

                const [nodeRows, tagRows, ownedByRows] = await Promise.all([
                    this.debug.time(
                        "buildSimilarityBatch.buildOwnedMemoryEntries.getNode",
                        () =>
                            this.store.query<RawMemoryRow>(
                                `SELECT id, content, event_time, created_at, token_count, structured_data
                                 FROM memory WHERE id = $1`,
                                [memId],
                            ),
                    ),
                    this.debug.time(
                        "buildSimilarityBatch.buildOwnedMemoryEntries.fetchTags",
                        () =>
                            this.store.query<{ label: string }>(
                                `SELECT t.label FROM tagged tg
                                 JOIN tag t ON t.id = tg.out_id
                                 WHERE tg.in_id = $1`,
                                [memId],
                            ),
                    ),
                    targetDomainId
                        ? this.debug.time(
                              "buildSimilarityBatch.buildOwnedMemoryEntries.fetchOwnedBy",
                              // Filter on `in_id` only and reduce in JS — keeps
                              // the per-direction `idx_owned_by_in` hit and avoids
                              // any planner issue when both sides are constrained.
                              async () => {
                                  const rows = await this.store.query<{
                                      attributes: unknown;
                                      owned_at: number | null;
                                      out_id: string;
                                  }>(
                                      `SELECT attributes, owned_at, out_id
                                       FROM owned_by WHERE in_id = $1`,
                                      [memId],
                                  );
                                  return rows.filter((r) => r.out_id === targetDomainId);
                              },
                          )
                        : Promise.resolve(null),
                ]);

                const node = nodeRows[0];
                if (!node) return null;

                const memory = this.toMemoryEntry(node);

                const tags = tagRows
                    .map((r) => r.label)
                    .filter((label) => !label.startsWith("inbox"));

                const firstOwned = ownedByRows?.[0];
                const domainAttributes: Record<string, unknown> =
                    firstOwned && firstOwned.attributes && typeof firstOwned.attributes === "object"
                        ? (firstOwned.attributes as Record<string, unknown>)
                        : {};

                const sd = node.structured_data;
                // Two shapes are supported on `memory.structured_data`:
                //   1. Flat — `{ country: 'BFA', cameo_root: '14', ... }` — the
                //      shape ingest callers (GDELT, V-Dem, etc.) pass through
                //      `engine.ingest({ structuredData: ... })`. Surfaces to
                //      every domain that owns the memory.
                //   2. Domain-keyed — `{ "domain:conflict": { ... } }` — the
                //      shape used when distinct payloads must be visible to
                //      different owning domains.
                // Prefer the domain-keyed slice when present; otherwise return
                // the flat object. The earlier "domain-keyed only" branch
                // silently dropped structuredData for every flat-shape caller,
                // breaking conflict-topic-linking matchedSeeds.
                let structuredData: unknown;
                if (sd && typeof sd === "object") {
                    if (domainId && domainId in sd) {
                        structuredData = (sd as Record<string, unknown>)[domainId];
                    } else {
                        structuredData = sd;
                    }
                } else {
                    structuredData = undefined;
                }

                return { memory, domainAttributes, tags, structuredData };
            }),
        );

        return perMemory.filter((entry): entry is OwnedMemory => entry !== null);
    }

    // --- Phase 1: Claim Assertion ---

    private async processAssertionBatch(): Promise<number> {
        return this.debug.time("assertBatch.total", async () => {
            const batch = await this.buildSimilarityBatch({ type: "assert-claim" });
            if (!batch) return 0;

            const { batchId, entries, memoryIds, requestContext } = batch;

            try {
                const memoryDomainMap = new Map<string, string[]>();
                const allDomainIds = new Set<string>();

                for (const memId of memoryIds) {
                    const tagRows = await this.store.query<{ label: string }>(
                        `SELECT t.label FROM tagged tg
                         JOIN tag t ON t.id = tg.out_id
                         WHERE tg.in_id = $1
                           AND t.label LIKE 'inbox:assert-claim:%'`,
                        [memId],
                    );
                    const domainIds = tagRows.map((r) =>
                        r.label.slice("inbox:assert-claim:".length),
                    );
                    memoryDomainMap.set(memId, domainIds);
                    for (const d of domainIds) allDomainIds.add(d);
                }

                for (const did of allDomainIds) {
                    const domain = this.domainRegistry.get(did);
                    if (!domain?.assertInboxClaimBatch) continue;

                    const domainEntries = entries.filter((e) =>
                        memoryDomainMap.get(e.memory.id)?.includes(did),
                    );
                    if (domainEntries.length === 0) continue;

                    const domainMemoryIds = domainEntries.map((e) => e.memory.id);
                    const assertTagId = `tag:inbox:assert-claim:${did}`;

                    const ctx = this.contextFactory(did, requestContext);
                    try {
                        const claimedIds = await this.debug.time(
                            "assertBatch.domain",
                            () => domain.assertInboxClaimBatch!(domainEntries, ctx),
                            { domainId: did, entries: domainEntries.length },
                        );
                        await this.clearBatchFailureRecord(
                            "assert",
                            did,
                            domainMemoryIds,
                            requestContext,
                        );

                        for (const memId of claimedIds) {
                            const fullDomainId = `domain:${did}`;
                            await this.store.relate(memId, "owned_by", fullDomainId, {
                                attributes: {},
                                owned_at: Date.now(),
                            });
                            const inboxTagId = `tag:inbox:${did}`;
                            try {
                                await this.store.createNodeWithId(inboxTagId, {
                                    label: `inbox:${did}`,
                                    created_at: Date.now(),
                                });
                            } catch {
                                /* already exists */
                            }
                            await this.store.relate(memId, "tagged", inboxTagId);
                        }

                        for (const memId of domainMemoryIds) {
                            await this.store.unrelate(memId, "tagged", assertTagId);
                        }
                    } catch (err) {
                        this.events.emit("error", {
                            source: "inbox-assertion",
                            domainId: did,
                            error: err,
                        });

                        const failure = await this.recordBatchFailure(
                            "assert",
                            did,
                            domainMemoryIds,
                            requestContext,
                            err,
                        );
                        if (failure.status === "quarantined") {
                            const failedTagId = await this.ensureTag(
                                `inbox:failed-assert-claim:${did}`,
                            );
                            for (const memId of domainMemoryIds) {
                                await this.store.unrelate(memId, "tagged", assertTagId);
                                await this.store.relate(memId, "tagged", failedTagId);
                            }
                        }
                    }
                }

                for (const memId of memoryIds) {
                    const owners = await this.store.query<{ count: number }>(
                        `SELECT COUNT(*)::int AS count FROM owned_by WHERE in_id = $1`,
                        [memId],
                    );
                    const ownerCount = owners[0]?.count ?? 0;
                    const activeAssertCount = await this.countTagsByPrefix(
                        memId,
                        "inbox:assert-claim:",
                    );
                    const failedAssertCount = await this.countTagsByPrefix(
                        memId,
                        "inbox:failed-assert-claim:",
                    );

                    if (ownerCount === 0 && activeAssertCount === 0 && failedAssertCount === 0) {
                        await this.removeOrphanedMemory(memId);
                    } else {
                        await this.clearRootInboxIfNoActiveTags(memId);
                    }
                    this.events.emit("inboxClaimAsserted", {
                        memoryId: memId,
                        claimed: ownerCount > 0,
                    });
                }
            } finally {
                await this.removeBatchProcessingTag(batchId);
            }

            return memoryIds.length;
        });
    }

    // --- Phase 2: Inbox Processing ---

    private async processInboxBatch(): Promise<number> {
        return this.debug.time("processBatch.total", async () => {
            const taggedRows = await this.store.query<{ in_id: string; label: string }>(
                `SELECT tg.in_id, t.label FROM tagged tg
                 JOIN tag t ON t.id = tg.out_id
                 WHERE t.label LIKE 'inbox:%'
                   AND t.label NOT LIKE 'inbox:assert-claim:%'
                   AND t.label NOT LIKE 'inbox:failed%'
                   AND t.label NOT LIKE 'inbox:processing:%'
                 LIMIT $1`,
                [this.batchLimit * 10],
            );
            if (taggedRows.length === 0) return 0;

            const domainIds = new Set<string>();
            for (const row of taggedRows) domainIds.add(row.label.slice("inbox:".length));

            let totalProcessed = 0;
            for (const did of domainIds) {
                const domain = this.domainRegistry.get(did);
                if (!domain) continue;

                const batch = await this.buildSimilarityBatch({ type: "domain", domainId: did }, did);
                if (!batch) continue;

                const { batchId, entries, memoryIds, requestContext } = batch;
                try {
                    const ctx = this.contextFactory(did, requestContext);
                    const inboxTagId = `tag:inbox:${did}`;

                    try {
                        await this.debug.time(
                            "processBatch.domain",
                            () => domain.processInboxBatch(entries, ctx),
                            { domainId: did, entries: entries.length },
                        );
                        await this.clearBatchFailureRecord(
                            "process",
                            did,
                            memoryIds,
                            requestContext,
                        );
                    } catch (err) {
                        this.events.emit("error", { source: "inbox", domainId: did, error: err });
                        const failure = await this.recordBatchFailure(
                            "process",
                            did,
                            memoryIds,
                            requestContext,
                            err,
                        );
                        if (failure.status === "quarantined") {
                            const failedTagId = await this.ensureTag(`inbox:failed:${did}`);
                            await Promise.all(
                                memoryIds.map(async (memId) => {
                                    await this.store.unrelate(memId, "tagged", inboxTagId);
                                    await this.store.relate(memId, "tagged", failedTagId);
                                    await this.clearRootInboxIfNoActiveTags(memId);
                                }),
                            );
                        }
                        continue;
                    }

                    await Promise.all(
                        memoryIds.map(async (memId) => {
                            await this.store.unrelate(memId, "tagged", inboxTagId);
                            this.events.emit("inboxDomainProcessed", {
                                memoryId: memId,
                                domainId: did,
                            });
                        }),
                    );
                    await Promise.all(
                        memoryIds.map((memId) => this.clearRootInboxIfNoActiveTags(memId)),
                    );

                    totalProcessed += memoryIds.length;
                } finally {
                    await this.removeBatchProcessingTag(batchId);
                }
            }
            return totalProcessed;
        });
    }

    // --- Cleanup ---

    private async removeOrphanedMemory(memId: string): Promise<void> {
        await this.store.query(`DELETE FROM tagged WHERE in_id = $1`, [memId]);
        await this.store.deleteNode(memId);
        this.events.emit("deleted", { memoryId: memId, reason: "unclaimed" });
    }

    // --- Tick & Lifecycle ---

    async tick(): Promise<boolean> {
        return this.debug.time("tick", async () => {
            try {
                const acquired = await this.acquireLock();
                if (!acquired) return false;

                try {
                    await this.recoverStaleBatches();
                    await this.backfillAssertClaimLinks();
                    const asserted = await this.processAssertionBatch();
                    const processed = await this.processInboxBatch();
                    return asserted > 0 || processed > 0;
                } catch (err) {
                    this.events.emit("error", { source: "inbox", error: err });
                    return false;
                }
            } finally {
                await this.releaseLock();
                this.scheduleNext();
            }
        });
    }

    start(options?: InboxProcessorOptions): void {
        if (this.running) return;
        if (options?.intervalMs != null) this.intervalMs = options.intervalMs;
        if (options?.batchLimit != null) this.batchLimit = options.batchLimit;
        if (options?.staleAfterMs != null) this.staleAfterMs = options.staleAfterMs;
        if (options?.similarityThreshold != null)
            this.similarityThreshold = options.similarityThreshold;
        this.running = true;
        this.scheduleNext();
    }

    stop(): void {
        this.running = false;
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    private scheduleNext(): void {
        if (!this.running) return;
        this.timeout = setTimeout(() => {
            void this.tick();
        }, this.intervalMs);
    }

    private async acquireLock(): Promise<boolean> {
        const existing = await this.store.getNode<Node & { value?: string }>("meta:_inbox_lock");
        if (existing?.value) {
            const parsed: unknown = JSON.parse(existing.value);
            const lockedAt =
                parsed && typeof parsed === "object" && "lockedAt" in parsed
                    ? (parsed as { lockedAt: unknown }).lockedAt
                    : undefined;
            if (typeof lockedAt === "number") {
                const age = Date.now() - lockedAt;
                if (age < this.staleAfterMs) return false;
            }
        }
        const payload: InboxLockPayload = { lockedAt: Date.now() };
        try {
            if (existing) {
                await this.store.updateNode("meta:_inbox_lock", { value: JSON.stringify(payload) });
            } else {
                await this.store.createNodeWithId("meta:_inbox_lock", {
                    value: JSON.stringify(payload),
                });
            }
        } catch {
            return false;
        }
        return true;
    }

    private async releaseLock(): Promise<void> {
        try {
            await this.store.deleteNode("meta:_inbox_lock");
        } catch {
            /* best-effort — staleness handles it */
        }
    }
}

export { InboxProcessor };
export type { InboxProcessorOptions };
