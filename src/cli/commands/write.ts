import type { CommandHandler } from "../types.js";
import type { WriteOptions } from "../../core/types.js";
import { parseMeta } from "../utils.js";

const writeCommand: CommandHandler = async (engine, parsed) => {
    const text = parsed.flags["text"] as string | undefined;
    const domain = parsed.flags["domain"] as string | undefined;

    if (!domain) return { output: { error: "--domain is required" }, exitCode: 1 };
    if (!text) return { output: { error: "--text is required" }, exitCode: 1 };

    const options: WriteOptions = { domain };
    if (parsed.flags["tags"]) options.tags = (parsed.flags["tags"] as string).split(",");

    const attr = parsed.flags["attr"];
    if (attr && typeof attr === "object") options.attributes = attr;

    const meta = parseMeta(parsed.flags);
    if (meta) options.context = meta;

    const result = await engine.writeMemory(text, options);
    return { output: result, exitCode: 0 };
};

export { writeCommand };
