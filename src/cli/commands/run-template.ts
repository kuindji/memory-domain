import { readFileSync } from "fs";
import type { CommandHandler } from "../types.js";
import type { TemplateParams } from "../../core/types.js";

const runTemplateCommand: CommandHandler = async (engine, parsed) => {
    const domainId = parsed.args[0];
    const templateName = parsed.args[1];
    if (!domainId) {
        return {
            output: { error: "Domain id is required as first positional argument." },
            exitCode: 1,
        };
    }
    if (!templateName) {
        return {
            output: { error: "Template name is required as second positional argument." },
            exitCode: 1,
        };
    }

    const paramsRaw = parsed.flags["params"];
    const paramsFile = parsed.flags["params-file"];

    let paramsSource: string;
    if (typeof paramsFile === "string") {
        try {
            paramsSource = readFileSync(paramsFile, "utf8");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                output: { error: `Failed to read --params-file: ${message}` },
                exitCode: 1,
            };
        }
    } else if (typeof paramsRaw === "string") {
        paramsSource = paramsRaw;
    } else {
        paramsSource = "{}";
    }

    let params: TemplateParams;
    try {
        const parsedJson: unknown = JSON.parse(paramsSource);
        if (parsedJson === null || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
            return {
                output: { error: "Params must be a JSON object." },
                exitCode: 1,
            };
        }
        params = parsedJson as TemplateParams;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            output: { error: `Invalid params JSON: ${message}` },
            exitCode: 1,
        };
    }

    const result = await engine.runTemplate(domainId, templateName, params);
    return { output: result, exitCode: 0, formatCommand: "run-template" };
};

export { runTemplateCommand };
