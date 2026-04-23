#!/usr/bin/env node
import { parseArgs } from "./parse-args.js";
import { formatError } from "./format.js";
import { getHelpText, getCommandHelp } from "./commands/help.js";
import { loadConfig } from "../config-loader.js";
import { dispatchCommand } from "../serve/dispatch.js";

async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));

    // Handle help early (no engine needed)
    if (parsed.command === "help") {
        const specificHelp = parsed.args[0] ? getCommandHelp(parsed.args[0]) : null;
        console.log(specificHelp ?? getHelpText());
        process.exit(0);
    }

    // Refuse nested ask() from inside an ongoing ask() agent loop.
    if (process.env["MEMORY_DOMAIN_INNER_ASK"] === "1" && parsed.command === "ask") {
        console.error(
            formatError(
                "RECURSION_BLOCKED",
                "ask is not available inside an ongoing ask() loop; answer from the data you already have.",
            ),
        );
        process.exit(2);
    }

    // Load engine from config
    let engine;
    try {
        const cwd = typeof parsed.flags["cwd"] === "string" ? parsed.flags["cwd"] : undefined;
        const config =
            typeof parsed.flags["config"] === "string" ? parsed.flags["config"] : undefined;
        engine = await loadConfig(cwd, config);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(formatError("CONFIG_ERROR", message));
        process.exit(1);
    }

    const pretty = parsed.flags["pretty"] === true;

    let exitCode = 1;
    try {
        const result = await dispatchCommand(engine, parsed, { pretty });
        if (result.ok) {
            if (result.rendered) console.log(result.rendered);
        } else {
            console.error(result.rendered);
        }
        exitCode = result.exitCode;
    } finally {
        await engine.close();
        await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
        process.exit(exitCode);
    }
}

void main();
