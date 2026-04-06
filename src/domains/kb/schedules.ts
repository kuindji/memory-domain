import { StringRecordId } from "surrealdb";
import type { DomainContext } from "../../core/types.js";
import { KB_DOMAIN_ID, KB_TAG } from "./types.js";
import { ensureTag } from "./utils.js";

interface OwnershipRow {
    in: string;
    attributes: Record<string, unknown>;
}

export async function consolidateKnowledge(context: DomainContext): Promise<void> {
    await context.debug.time("kb.schedule.consolidate", async () => {
        const similarityThreshold = 0.8;
        const minClusterSize = 3;

        // Get all non-superseded KB memories
        const rows = await context.graph.query<OwnershipRow[]>(
            "SELECT in, attributes FROM owned_by WHERE out = $domainId AND attributes.superseded = false AND attributes.decomposed != true",
            { domainId: new StringRecordId(`domain:${KB_DOMAIN_ID}`) },
        );
        if (!rows || rows.length === 0) return;

        // Group by classification for within-classification consolidation
        const byClassification = new Map<
            string,
            { memId: string; attrs: Record<string, unknown> }[]
        >();
        for (const row of rows) {
            const memId = String(row.in);
            const classification = (row.attributes.classification as string) ?? "fact";
            let group = byClassification.get(classification);
            if (!group) {
                group = [];
                byClassification.set(classification, group);
            }
            group.push({ memId, attrs: row.attributes });
        }

        for (const [classification, group] of byClassification) {
            if (group.length < minClusterSize) continue;

            const clustered = new Set<string>();
            const clusters: string[][] = [];

            for (const item of group) {
                if (clustered.has(item.memId)) continue;

                const memory = await context.getMemory(item.memId);
                if (!memory) continue;

                const searchResult = await context.search({
                    text: memory.content,
                    tags: [KB_TAG],
                    attributes: { classification, superseded: false },
                    minScore: similarityThreshold,
                });

                const clusterMembers = searchResult.entries
                    .filter(
                        (entry) =>
                            !clustered.has(entry.id) && group.some((g) => g.memId === entry.id),
                    )
                    .map((entry) => entry.id);

                if (clusterMembers.length >= minClusterSize) {
                    clusters.push(clusterMembers);
                    for (const id of clusterMembers) {
                        clustered.add(id);
                    }
                }
            }

            for (const cluster of clusters) {
                const contents: string[] = [];
                for (const memId of cluster) {
                    const memory = await context.getMemory(memId);
                    if (memory) {
                        contents.push(memory.content);
                    }
                }

                if (contents.length === 0) continue;

                const summary = await context.debug.time(
                    "kb.schedule.consolidate.summary",
                    () => context.llmAt("medium").consolidate(contents),
                    { memories: contents.length, classification },
                );
                if (!summary) continue;

                const kbTagId = await ensureTag(context, KB_TAG);
                const classTag = `kb/${classification}`;
                const classTagId = await ensureTag(context, classTag);
                try {
                    await context.graph.relate(classTagId, "child_of", kbTagId);
                } catch {
                    /* already related */
                }

                const consolidatedId = await context.writeMemory({
                    content: summary,
                    tags: [KB_TAG, classTag],
                    ownership: {
                        domain: KB_DOMAIN_ID,
                        attributes: {
                            classification,
                            superseded: false,
                            source: "consolidated",
                        },
                    },
                });

                for (const memId of cluster) {
                    await context.graph.relate(consolidatedId, "supersedes", memId);
                    const item = group.find((g) => g.memId === memId);
                    if (item) {
                        await context.updateAttributes(memId, {
                            ...item.attrs,
                            superseded: true,
                        });
                    }
                }
            }
        }
    });
}
