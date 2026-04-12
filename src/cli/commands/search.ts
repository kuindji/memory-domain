import type { CommandHandler } from "../types.js";
import type { SearchQuery } from "../../core/types.js";
import { parseMeta } from "../utils.js";

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

    const meta = parseMeta(parsed.flags);
    if (meta) {
        query.context = meta;
    }

    const result = await engine.search(query);
    return { output: result, exitCode: 0 };
};

export { searchCommand };
