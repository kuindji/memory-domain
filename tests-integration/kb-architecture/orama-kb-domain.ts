import { StringRecordId } from "surrealdb";
import { createKbDomain } from "../../src/domains/kb/kb-domain.js";
import type {
    DomainConfig,
    DomainContext,
    ContextResult,
    ScoredMemory,
} from "../../src/core/types.js";
import { countTokens } from "../../src/core/scoring.js";
import { KB_DOMAIN_ID } from "../../src/domains/kb/types.js";
import {
    isEntryValid,
    getKbAttrs,
    recordAccess,
    computeImportance,
} from "../../src/domains/kb/utils.js";
import { searchOrama } from "./orama-index.js";
import type { OramaDb } from "./orama-index.js";

function extractWordSet(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2),
    );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const word of a) {
        if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
}

interface DedupResult {
    entries: ScoredMemory[];
    /** Maps removed entry ID → surviving entry ID that absorbed it */
    aliases: Map<string, string>;
}

function deduplicateByContent(entries: ScoredMemory[], threshold: number): DedupResult {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    const accepted: Array<{ mem: ScoredMemory; words: Set<string> }> = [];
    const aliases = new Map<string, string>();

    for (const entry of sorted) {
        const words = extractWordSet(entry.content);
        const match = accepted.find((a) => jaccardSimilarity(a.words, words) >= threshold);
        if (match) {
            aliases.set(entry.id, match.mem.id);
        } else {
            accepted.push({ mem: entry, words });
        }
    }

    return { entries: accepted.map((a) => a.mem), aliases };
}

async function resolveToParents(
    entries: ScoredMemory[],
    context: DomainContext,
    now: number,
): Promise<ScoredMemory[]> {
    const parentMap = new Map<string, { mem: ScoredMemory; bestScore: number }>();
    const standalone: ScoredMemory[] = [];

    for (const entry of entries) {
        const attrs = getKbAttrs(entry.domainAttributes);
        const parentId = attrs?.parentMemoryId as string | undefined;

        if (!parentId) {
            standalone.push(entry);
            continue;
        }

        const existing = parentMap.get(parentId);
        if (existing) {
            if (entry.score > existing.bestScore) {
                existing.bestScore = entry.score;
                existing.mem = { ...existing.mem, score: entry.score };
            }
            continue;
        }

        const parentMemory = await context.getMemory(parentId);
        if (!parentMemory) {
            standalone.push(entry);
            continue;
        }

        const parentDomainRef = new StringRecordId(`domain:${KB_DOMAIN_ID}`);
        const parentMemRef = new StringRecordId(parentId);
        const attrRows = await context.graph.query<Array<{ attributes: Record<string, unknown> }>>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId LIMIT 1",
            {
                memId: parentMemRef,
                domainId: parentDomainRef,
            },
        );

        const parentAttrs = attrRows?.[0]?.attributes ?? {};

        if (parentAttrs.superseded) continue;
        if (typeof parentAttrs.validUntil === "number" && parentAttrs.validUntil < now) continue;

        const parentScored: ScoredMemory = {
            id: parentMemory.id,
            content: parentMemory.content,
            score: entry.score,
            scores: {},
            tags: [],
            domainAttributes: { [KB_DOMAIN_ID]: parentAttrs },
            eventTime: parentMemory.eventTime,
            createdAt: parentMemory.createdAt,
            tokenCount: parentMemory.tokenCount,
        };

        parentMap.set(parentId, { mem: parentScored, bestScore: entry.score });
    }

    const parentIds = new Set(parentMap.keys());
    const deduped = standalone.filter((e) => !parentIds.has(e.id));

    return [...deduped, ...[...parentMap.values()].map((p) => p.mem)];
}

/**
 * Creates a buildContext function that uses Orama for search.
 * Can be used to patch an existing domain's buildContext on a live engine.
 */
export function createOramaBuildContext(oramaIndex: OramaDb): DomainConfig["buildContext"] {
    return async (text, budgetTokens, context) => {
        return oramaBuildContext(oramaIndex, text, budgetTokens, context);
    };
}

async function oramaBuildContext(
    oramaIndex: OramaDb,
    text: string,
    budgetTokens: number,
    context: DomainContext,
): Promise<ContextResult> {
    const empty: ContextResult = { context: "", memories: [], totalTokens: 0 };
    if (!text) return empty;

    const now = Date.now();
    const decayFactor = context.getTunableParam("decayFactor") ?? 0.95;

    const candidateLimit = Math.max(50, Math.ceil(budgetTokens / 20));
    let entries = searchOrama(oramaIndex, text, candidateLimit);

    // Validity filter
    entries = entries.filter((e) => isEntryValid(getKbAttrs(e.domainAttributes), now));
    if (entries.length === 0) return empty;

    // Importance adjustment (same as original rank())
    entries = entries.map((e) => {
        const attrs = getKbAttrs(e.domainAttributes);
        const imp = computeImportance(attrs ?? {}, decayFactor);
        return { ...e, score: e.score * (1 + (imp - 0.5) * 0.5) };
    });
    entries.sort((a, b) => b.score - a.score);

    // Parent resolution
    const resolved = await resolveToParents(entries, context, now);

    // Deduplication (Jaccard, threshold 0.5)
    const { entries: deduped, aliases: dedupAliases } = deduplicateByContent(resolved, 0.5);
    deduped.sort((a, b) => b.score - a.score);

    // Budget fill
    const selected: Array<{ mem: ScoredMemory; classification: string }> = [];
    let usedTokens = 0;
    for (const entry of deduped) {
        const tokens = countTokens(entry.content);
        if (usedTokens + tokens > budgetTokens) continue;
        usedTokens += tokens;

        const attrs = getKbAttrs(entry.domainAttributes);
        const cls = (attrs?.classification as string) ?? "fact";
        selected.push({ mem: entry, classification: cls });
    }

    if (selected.length === 0) return empty;

    // Group by classification for formatted output
    const groups = new Map<string, ScoredMemory[]>();
    for (const { mem, classification } of selected) {
        let group = groups.get(classification);
        if (!group) {
            group = [];
            groups.set(classification, group);
        }
        group.push(mem);
    }

    const sections: string[] = [];
    const allMemories: ScoredMemory[] = [];

    const defConcept = [...(groups.get("definition") ?? []), ...(groups.get("concept") ?? [])];
    if (defConcept.length > 0) {
        sections.push(`[Definitions & Concepts]\n${defConcept.map((e) => e.content).join("\n")}`);
        allMemories.push(...defConcept);
    }

    const factRef = [...(groups.get("fact") ?? []), ...(groups.get("reference") ?? [])];
    if (factRef.length > 0) {
        sections.push(`[Facts & References]\n${factRef.map((e) => e.content).join("\n")}`);
        allMemories.push(...factRef);
    }

    const howtoInsight = [...(groups.get("how-to") ?? []), ...(groups.get("insight") ?? [])];
    if (howtoInsight.length > 0) {
        sections.push(`[How-Tos & Insights]\n${howtoInsight.map((e) => e.content).join("\n")}`);
        allMemories.push(...howtoInsight);
    }

    const finalContext = sections.join("\n\n");

    // Include dedup aliases
    const selectedIds = new Set(allMemories.map((m) => m.id));
    for (const [aliasId, survivorId] of dedupAliases) {
        if (selectedIds.has(survivorId)) {
            const survivor = allMemories.find((m) => m.id === survivorId);
            if (survivor) {
                allMemories.push({ ...survivor, id: aliasId });
            }
        }
    }

    // Record access for importance tracking (fire-and-forget)
    Promise.all(
        allMemories.map((m) =>
            recordAccess(context, m.id, getKbAttrs(m.domainAttributes)).catch(() => {}),
        ),
    ).catch(() => {});

    return {
        context: finalContext,
        memories: allMemories,
        totalTokens: countTokens(finalContext),
    };
}

export function createOramaKbDomain(oramaIndex: OramaDb): DomainConfig {
    const baseDomain = createKbDomain({ consolidateSchedule: { enabled: false } });

    return {
        ...baseDomain,
        buildContext: (text, budgetTokens, context) =>
            oramaBuildContext(oramaIndex, text, budgetTokens, context),
    };
}
