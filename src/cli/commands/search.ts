import type { CommandHandler } from "../types.js";
import type { SearchQuery } from "../../core/types.js";
import { parseMeta } from "../utils.js";

/**
 * Returns:
 *  - undefined when the flag was not supplied
 *  - null on parse failure (caller should reject the command)
 *  - a unix-ms number on success
 *
 * Accepts either a numeric unix-ms value or anything Date.parse handles
 * (ISO 8601, RFC 2822, etc.).
 */
function parseTimestampFlag(value: unknown): number | null | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const raw = String(value).trim();
    if (raw === "") return undefined;
    if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

const searchCommand: CommandHandler = async (engine, parsed) => {
    // Query text is positional (first arg), but fall back to --text or --query
    // flags for agents that pass it as a named flag instead.
    const text =
        parsed.args[0] ??
        (parsed.flags["text"] as string | undefined) ??
        (parsed.flags["query"] as string | undefined);

    if (!text) {
        return { output: { error: "Search query is required." }, exitCode: 1 };
    }

    const query: SearchQuery = { text };

    if (parsed.flags["mode"]) {
        query.mode = parsed.flags["mode"] as SearchQuery["mode"];
    }
    if (parsed.flags["domains"]) {
        query.domains = (parsed.flags["domains"] as string).split(",");
    }
    if (parsed.flags["tags"]) {
        query.tags = (parsed.flags["tags"] as string).split(",");
    }
    if (parsed.flags["limit"]) {
        query.limit = Number(parsed.flags["limit"]);
    }
    if (parsed.flags["budget"]) {
        query.tokenBudget = Number(parsed.flags["budget"]);
    }
    if (parsed.flags["min-score"]) {
        query.minScore = Number(parsed.flags["min-score"]);
    }
    const afterTime = parseTimestampFlag(parsed.flags["after-time"]);
    if (afterTime !== undefined) {
        if (afterTime === null) {
            return {
                output: { error: "Invalid --after-time: expected ISO date or unix-ms number." },
                exitCode: 1,
            };
        }
        query.afterTime = afterTime;
    }
    const beforeTime = parseTimestampFlag(parsed.flags["before-time"]);
    if (beforeTime !== undefined) {
        if (beforeTime === null) {
            return {
                output: { error: "Invalid --before-time: expected ISO date or unix-ms number." },
                exitCode: 1,
            };
        }
        query.beforeTime = beforeTime;
    }

    const meta = parseMeta(parsed.flags);
    if (meta) {
        query.context = meta;
    }

    const result = await engine.search(query);
    return { output: result, exitCode: 0 };
};

export { searchCommand };
