import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type {
    DomainConfig,
    DomainSchedule,
    SearchQuery,
    DomainContext,
    ContextResult,
    ScoredMemory,
} from "../../core/types.js";
import { countTokens } from "../../core/scoring.js";
import {
    CHAT_DOMAIN_ID,
    CHAT_MESSAGE_TAG,
    CHAT_EPISODIC_TAG,
    CHAT_SEMANTIC_TAG,
    DEFAULT_PROMOTE_INTERVAL_MS,
    DEFAULT_CONSOLIDATE_INTERVAL_MS,
    DEFAULT_PRUNE_INTERVAL_MS,
} from "./types.js";
import type { ChatDomainOptions } from "./types.js";
import { chatSkills } from "./skills.js";
import { processInboxBatch } from "./inbox.js";
import { promoteWorkingMemory, consolidateEpisodic, pruneDecayed } from "./schedules.js";

function buildSchedules(options?: ChatDomainOptions): DomainSchedule[] {
    const schedules: DomainSchedule[] = [];

    if (options?.promoteSchedule?.enabled !== false) {
        schedules.push({
            id: "promote-working-memory",
            name: "Promote working memory",
            intervalMs: options?.promoteSchedule?.intervalMs ?? DEFAULT_PROMOTE_INTERVAL_MS,
            run: (context: DomainContext) => promoteWorkingMemory(context, options),
        });
    }

    if (options?.consolidateSchedule?.enabled !== false) {
        schedules.push({
            id: "consolidate-episodic",
            name: "Consolidate episodic memory",
            intervalMs: options?.consolidateSchedule?.intervalMs ?? DEFAULT_CONSOLIDATE_INTERVAL_MS,
            run: (context: DomainContext) => consolidateEpisodic(context, options),
        });
    }

    if (options?.pruneSchedule?.enabled !== false) {
        schedules.push({
            id: "prune-decayed",
            name: "Prune decayed memories",
            intervalMs: options?.pruneSchedule?.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
            run: (context: DomainContext) => pruneDecayed(context, options),
        });
    }

    return schedules;
}

export function createChatDomain(options?: ChatDomainOptions): DomainConfig {
    return {
        id: CHAT_DOMAIN_ID,
        name: "Chat",
        baseDir: dirname(fileURLToPath(import.meta.url)),
        schema: {
            nodes: [],
            edges: [{ name: "summarizes", from: "memory", to: "memory" }],
        },
        skills: chatSkills,
        processInboxBatch,
        schedules: buildSchedules(options),
        describe() {
            return "Built-in conversational memory with tiered lifecycle. Stores raw messages as working memory, extracts highlights into episodic memory, and consolidates long-term knowledge into semantic memory.";
        },
        search: {
            expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
                const userId = context.requestContext.userId as string | undefined;
                if (!userId) {
                    return Promise.resolve({ ...query, ids: [] });
                }
                return Promise.resolve(query);
            },
        },

        async buildContext(
            text: string,
            budgetTokens: number,
            context: DomainContext,
        ): Promise<ContextResult> {
            const empty: ContextResult = { context: "", memories: [], totalTokens: 0 };

            const userId = context.requestContext.userId as string | undefined;
            if (!userId) return empty;

            const chatSessionId = context.requestContext.chatSessionId as string | undefined;

            const workingBudget = Math.floor(budgetTokens * 0.5);
            const episodicBudget = Math.floor(budgetTokens * 0.3);
            const semanticBudget = Math.floor(budgetTokens * 0.2);

            const allMemories: ScoredMemory[] = [];
            const sections: string[] = [];

            // Section 1 — [Recent]: working memory from current session
            if (chatSessionId) {
                const workingMemories = await context.getMemories({
                    tags: [CHAT_MESSAGE_TAG],
                    attributes: { chatSessionId, userId, layer: "working" },
                });

                // Sort by createdAt ascending (oldest first)
                workingMemories.sort((a, b) => a.createdAt - b.createdAt);

                let workingTokens = 0;
                const recentLines: string[] = [];
                for (const mem of workingMemories) {
                    const tokens = countTokens(mem.content);
                    if (workingTokens + tokens > workingBudget) break;
                    workingTokens += tokens;
                    recentLines.push(mem.content);
                    allMemories.push({
                        id: mem.id,
                        content: mem.content,
                        score: 1,
                        scores: {},
                        tags: [],
                        domainAttributes: {},
                        eventTime: mem.eventTime ?? null,
                        createdAt: mem.createdAt,
                        tokenCount: tokens,
                    });
                }

                if (recentLines.length > 0) {
                    sections.push(`[Recent]\n${recentLines.join("\n")}`);
                }
            }

            // Section 2 — [Context]: episodic memories via search
            if (text) {
                const episodicResult = await context.search({
                    text,
                    tags: [CHAT_EPISODIC_TAG],
                    tokenBudget: episodicBudget,
                });

                const episodicEntries = episodicResult.entries.filter((e) => {
                    const attrs = e.domainAttributes[CHAT_DOMAIN_ID];
                    return attrs && attrs.userId === userId && attrs.layer === "episodic";
                });

                if (episodicEntries.length > 0) {
                    const contextLines = episodicEntries.map((e) => e.content);
                    sections.push(`[Context]\n${contextLines.join("\n")}`);
                    allMemories.push(...episodicEntries);
                }
            }

            // Section 3 — [Background]: semantic memories via search
            if (text) {
                const semanticResult = await context.search({
                    text,
                    tags: [CHAT_SEMANTIC_TAG],
                    tokenBudget: semanticBudget,
                });

                const semanticEntries = semanticResult.entries.filter((e) => {
                    const attrs = e.domainAttributes[CHAT_DOMAIN_ID];
                    return attrs && attrs.userId === userId && attrs.layer === "semantic";
                });

                if (semanticEntries.length > 0) {
                    const bgLines = semanticEntries.map((e) => e.content);
                    sections.push(`[Background]\n${bgLines.join("\n")}`);
                    allMemories.push(...semanticEntries);
                }
            }

            // Prepend core memories
            const core = await context.getCoreMemories();
            if (core.length > 0) {
                sections.unshift(`[Instructions]\n${core.map((m) => m.content).join("\n")}`);
            }

            const finalContext = sections.join("\n\n");
            const totalTokens = countTokens(finalContext);

            return {
                context: finalContext,
                memories: allMemories,
                totalTokens,
            };
        },
    };
}

export const chatDomain = createChatDomain();
