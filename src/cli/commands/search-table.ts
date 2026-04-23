import { readFileSync } from "fs";
import type { CommandHandler } from "../types.js";
import type { FilterSpec } from "../../core/types.js";

const searchTableCommand: CommandHandler = async (engine, parsed) => {
    const domainId = parsed.args[0];
    if (!domainId) {
        return {
            output: { error: "Domain id is required as first positional argument." },
            exitCode: 1,
        };
    }

    const filterRaw = parsed.flags["filter"];
    const filterFile = parsed.flags["filter-file"];

    let filterSource: string;
    if (typeof filterFile === "string") {
        try {
            filterSource = readFileSync(filterFile, "utf8");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                output: { error: `Failed to read --filter-file: ${message}` },
                exitCode: 1,
            };
        }
    } else if (typeof filterRaw === "string") {
        filterSource = filterRaw;
    } else {
        filterSource = "{}";
    }

    let filter: FilterSpec;
    try {
        const parsedJson: unknown = JSON.parse(filterSource);
        if (parsedJson === null || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
            return {
                output: { error: "Filter must be a JSON object." },
                exitCode: 1,
            };
        }
        filter = parsedJson as FilterSpec;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            output: { error: `Invalid filter JSON: ${message}` },
            exitCode: 1,
        };
    }

    const result = await engine.searchTable(domainId, filter);
    return { output: result, exitCode: 0, formatCommand: "search-table" };
};

export { searchTableCommand };
