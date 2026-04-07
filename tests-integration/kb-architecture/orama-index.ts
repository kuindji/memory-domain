import { create, insert, search } from "@orama/orama";
import type { Results, TypedDocument } from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../../src/core/engine.js";
import type { ScoredMemory } from "../../src/core/types.js";
import { computeImportance } from "../../src/domains/kb/utils.js";
import type { KbAttributes } from "../../src/domains/kb/types.js";
import { KB_DOMAIN_ID, KB_TAG } from "../../src/domains/kb/types.js";

const ORAMA_SCHEMA = {
    id: "string",
    content: "string",
    classification: "string",
    topics: "string[]",
    importance: "number",
    createdAt: "number",
    tokenCount: "number",
    superseded: "boolean",
    decomposed: "boolean",
    validUntil: "number",
    parentMemoryId: "string",
    confidence: "number",
} as const;

export type OramaDb = ReturnType<typeof create<typeof ORAMA_SCHEMA>>;

interface OwnershipRow {
    id: string;
    content: string;
    created_at: number;
    token_count: number;
    attributes: KbAttributes;
}

interface TopicRow {
    in: { id: string };
    content: string;
}

export async function buildOramaIndex(engine: MemoryEngine): Promise<OramaDb> {
    const graph = engine.getGraph();

    const ownershipRows = await graph.query<OwnershipRow[]>(
        "SELECT in.id AS id, in.content AS content, in.created_at AS created_at, in.token_count AS token_count, attributes FROM owned_by WHERE out = $domainId",
        { domainId: new StringRecordId("domain:kb") },
    );

    const topicRows = await graph.query<TopicRow[]>(
        "SELECT in, (SELECT content FROM ONLY $parent.out).content AS content FROM about_topic",
    );

    // Build a map from memory id to topic list
    const topicsByMemory = new Map<string, string[]>();
    for (const row of topicRows) {
        const memId = String(row.in?.id ?? row.in);
        if (!memId || !row.content) continue;
        const existing = topicsByMemory.get(memId) ?? [];
        existing.push(row.content);
        topicsByMemory.set(memId, existing);
    }

    const db = create({ schema: ORAMA_SCHEMA });

    for (const row of ownershipRows) {
        const attrs = row.attributes ?? ({} as KbAttributes);
        const attrsRecord: Record<string, unknown> = { ...attrs };
        const importance = computeImportance(attrsRecord, 0.95);
        const memId = row.id;
        const topics = topicsByMemory.get(memId) ?? [];

        await insert(db, {
            id: memId,
            content: row.content ?? "",
            classification: String(attrs.classification ?? "fact"),
            topics,
            importance,
            createdAt: row.created_at ?? 0,
            tokenCount: row.token_count ?? 0,
            superseded: Boolean(attrs.superseded),
            decomposed: Boolean(attrs.decomposed),
            validUntil: typeof attrs.validUntil === "number" ? attrs.validUntil : 0,
            parentMemoryId: typeof attrs.parentMemoryId === "string" ? attrs.parentMemoryId : "",
            confidence: typeof attrs.confidence === "number" ? attrs.confidence : 1,
        });
    }

    return db;
}

export async function serializeOramaIndex(db: OramaDb, configName: string): Promise<void> {
    const filePath = join(import.meta.dir, "checkpoints", configName, "orama-index.json");
    mkdirSync(dirname(filePath), { recursive: true });
    const serialized = await persist(db, "json");
    writeFileSync(filePath, serialized as string, "utf-8");
    console.log(`[orama-index] Serialized index for "${configName}" → ${filePath}`);
}

export async function loadOramaIndex(configName: string): Promise<OramaDb> {
    const filePath = join(import.meta.dir, "checkpoints", configName, "orama-index.json");
    if (!existsSync(filePath)) {
        throw new Error(`Orama index not found: ${filePath}`);
    }
    const raw = readFileSync(filePath, "utf-8");
    return restore<OramaDb>("json", raw);
}

export function searchOrama(db: OramaDb, queryText: string, limit: number): ScoredMemory[] {
    type OramaDoc = TypedDocument<OramaDb>;
    const rawResults = search(db, {
        term: queryText,
        properties: ["content"],
        limit,
        threshold: 0,
    });
    // search() on a synchronous in-memory db always returns synchronously
    const results = rawResults as Results<OramaDoc>;

    return results.hits.map((hit) => {
        const doc = hit.document;
        const attrs: KbAttributes = {
            classification: doc.classification as KbAttributes["classification"],
            superseded: doc.superseded,
            decomposed: doc.decomposed,
            validUntil: doc.validUntil !== 0 ? doc.validUntil : undefined,
            parentMemoryId: doc.parentMemoryId !== "" ? doc.parentMemoryId : undefined,
            confidence: doc.confidence,
            importance: doc.importance,
        };
        return {
            id: doc.id,
            content: doc.content,
            score: hit.score,
            scores: { fulltext: hit.score },
            tags: [KB_TAG],
            domainAttributes: { [KB_DOMAIN_ID]: { ...attrs } },
            eventTime: null,
            createdAt: doc.createdAt,
            tokenCount: doc.tokenCount,
        };
    });
}
