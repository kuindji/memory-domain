import { StringRecordId } from "surrealdb";
import type { DomainContext } from "../../core/types.js";
import { USER_TAG } from "./types.js";

export async function consolidateUserProfile(context: DomainContext): Promise<void> {
    // Find all user nodes
    const userNodes = await context.graph.query<{ id: string; userId: string }[]>(
        "SELECT id, userId FROM user",
    );
    if (!userNodes || userNodes.length === 0) return;

    const now = Date.now();

    for (const userNode of userNodes) {
        const userNodeId = String(userNode.id);

        // Get all incoming edges to this user node
        const edges = await context.getNodeEdges(userNodeId, "in");
        if (edges.length === 0) continue;

        // Collect memory content from linked nodes, skipping superseded / expired entries
        const memoryIds = edges.map((e) => String(e.in)).filter((id) => id.startsWith("memory:"));
        const uniqueIds = [...new Set(memoryIds)];

        const contents: string[] = [];
        for (const memId of uniqueIds) {
            const memory = await context.getMemory(memId);
            if (!memory) continue;

            // Fetch user-domain attributes for this memory and skip if superseded/expired
            const attrRows = await context.graph.query<
                Array<{ attributes: Record<string, unknown> }>
            >("SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId LIMIT 1", {
                memId: new StringRecordId(memId),
                domainId: new StringRecordId(`domain:${context.domain}`),
            });
            const attrs = attrRows?.[0]?.attributes ?? {};
            if (attrs.superseded) continue;
            if (typeof attrs.validUntil === "number" && attrs.validUntil < now) continue;

            contents.push(memory.content);
        }
        if (contents.length === 0) continue;

        // Synthesize profile summary
        const medLlm = context.llmAt("medium");
        if (!medLlm.consolidate) continue;
        const summary = await medLlm.consolidate(contents);
        if (!summary.trim()) continue;

        // Find existing profile summary for this user
        const existingSummaries = await context.getMemories({
            tags: [`${USER_TAG}/profile-summary`],
            domains: [context.domain],
        });

        let existingSummaryId: string | undefined;
        for (const existing of existingSummaries) {
            const summaryEdges = await context.getNodeEdges(existing.id, "out");
            const linksToUser = summaryEdges.some((e) => String(e.out) === userNodeId);
            if (linksToUser) {
                existingSummaryId = existing.id;
                break;
            }
        }

        if (existingSummaryId) {
            await context.graph.updateNode(existingSummaryId, { content: summary });
        } else {
            const summaryId = await context.writeMemory({
                content: summary,
                tags: [`${USER_TAG}/profile-summary`],
                ownership: { domain: context.domain, attributes: {} },
            });
            await context.graph.relate(summaryId, "about_user", userNodeId, {
                domain: context.domain,
            });
        }
    }
}
