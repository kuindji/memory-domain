import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type {
    DomainConfig,
    DomainContext,
    ScoredMemory,
    SearchQuery,
    DomainSchedule,
} from "../../core/types.js";
import { USER_DOMAIN_ID, DEFAULT_CONSOLIDATE_INTERVAL_MS } from "./types.js";
import type { UserDomainOptions } from "./types.js";
import { userSkills } from "./skills.js";
import { consolidateUserProfile } from "./schedules.js";
import { processInboxBatch } from "./inbox.js";
import { isEntryValid, getUserAttrs, computeImportance } from "./utils.js";

function buildSchedules(options?: UserDomainOptions): DomainSchedule[] {
    if (options?.consolidateSchedule?.enabled === false) return [];

    const intervalMs = options?.consolidateSchedule?.intervalMs ?? DEFAULT_CONSOLIDATE_INTERVAL_MS;

    return [
        {
            id: "consolidate-user-profile",
            name: "Consolidate user profile",
            intervalMs,
            run: consolidateUserProfile,
        },
    ];
}

export function createUserDomain(options?: UserDomainOptions): DomainConfig {
    return {
        id: USER_DOMAIN_ID,
        name: "User",
        baseDir: dirname(fileURLToPath(import.meta.url)),
        schema: {
            nodes: [
                {
                    name: "user",
                    fields: [{ name: "userId", type: "string", required: true }],
                    indexes: [{ name: "user_userId_unique", fields: ["userId"], type: "unique" }],
                },
                {
                    name: "memory",
                    fields: [{ name: "classification", type: "option<string>" }],
                },
            ],
            edges: [
                {
                    name: "about_user",
                    from: "memory",
                    to: "user",
                    fields: [{ name: "domain", type: "string" }],
                },
                { name: "supersedes", from: "memory", to: "memory" },
            ],
        },
        skills: userSkills,
        processInboxBatch,
        schedules: buildSchedules(options),
        describe() {
            return "Built-in primitive for tracking facts about individual users. Manages user identity, preferences, expertise, goals, and automatic profile consolidation.";
        },
        search: {
            async expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
                const userId = context.requestContext.userId as string | undefined;
                if (!userId) return query;

                const userNodeId = `user:${userId}`;
                const userNode = await context.graph.getNode(userNodeId);
                if (!userNode) return query;

                return query;
            },

            rank(_query: SearchQuery, candidates: ScoredMemory[]): ScoredMemory[] {
                const now = Date.now();
                return candidates
                    .map((c) => {
                        const attrs = getUserAttrs(c.domainAttributes);
                        let score = c.score;
                        if (!isEntryValid(attrs, now)) {
                            score *= 0.05;
                        } else {
                            const imp = computeImportance(attrs, 0.95);
                            score *= 1 + (imp - 0.5) * 0.5;
                        }
                        return { ...c, score };
                    })
                    .sort((a, b) => b.score - a.score);
            },
        },
    };
}

export const userDomain = createUserDomain();
