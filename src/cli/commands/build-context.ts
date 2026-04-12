import type { CommandHandler } from "../types.js";
import type { ContextOptions } from "../../core/types.js";
import { parseMeta } from "../utils.js";

const buildContextCommand: CommandHandler = async (engine, parsed) => {
    // Query text is positional (first arg), but fall back to --text or --query
    // flags for agents that pass it as a named flag instead.
    const text =
        parsed.args[0] ??
        (parsed.flags["text"] as string | undefined) ??
        (parsed.flags["query"] as string | undefined);

    if (!text) {
        return { output: { error: "Text is required." }, exitCode: 1 };
    }

    const options: ContextOptions = {};

    if (parsed.flags["domains"]) {
        options.domains = (parsed.flags["domains"] as string).split(",");
    }
    if (parsed.flags["budget"]) {
        options.budgetTokens = Number(parsed.flags["budget"]);
    }
    if (parsed.flags["max-memories"]) {
        options.maxMemories = Number(parsed.flags["max-memories"]);
    }

    const meta = parseMeta(parsed.flags);
    if (meta) {
        options.context = meta;
    }

    const result = await engine.buildContext(text, options);
    return { output: result, exitCode: 0 };
};

export { buildContextCommand };
