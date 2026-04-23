import type { MemoryEngine } from "../core/engine.js";
import { formatOutput, formatError } from "../cli/format.js";
import type { CommandHandler, CommandResult, ParsedCommand } from "../cli/types.js";

import { initCommand } from "../cli/commands/init.js";
import { ingestCommand } from "../cli/commands/ingest.js";
import { searchCommand } from "../cli/commands/search.js";
import { searchTableCommand } from "../cli/commands/search-table.js";
import { askCommand } from "../cli/commands/ask.js";
import { buildContextCommand } from "../cli/commands/build-context.js";
import { domainsCommand, domainCommand } from "../cli/commands/domains.js";
import { writeCommand } from "../cli/commands/write.js";
import { memoryCommand } from "../cli/commands/memory.js";
import { graphCommand } from "../cli/commands/graph.js";
import { scheduleCommand } from "../cli/commands/schedule.js";
import { skillCommand } from "../cli/commands/skill.js";
import { coreMemoryCommand } from "../cli/commands/core-memory.js";

const COMMANDS: Record<string, CommandHandler> = {
    init: initCommand,
    ingest: ingestCommand,
    search: searchCommand,
    "search-table": searchTableCommand,
    ask: askCommand,
    "build-context": buildContextCommand,
    domains: domainsCommand,
    domain: domainCommand,
    write: writeCommand,
    memory: memoryCommand,
    graph: graphCommand,
    schedule: scheduleCommand,
    skill: skillCommand,
    "core-memory": coreMemoryCommand,
};

interface DispatchSuccess {
    ok: true;
    exitCode: 0;
    output: unknown;
    rendered: string;
    formatCommand?: string;
}

interface DispatchFailure {
    ok: false;
    exitCode: number;
    error: { code: string; message: string };
    rendered: string;
}

type DispatchResult = DispatchSuccess | DispatchFailure;

interface DispatchOptions {
    /** If set, commands outside the list return a COMMAND_NOT_ALLOWED failure. */
    allow?: readonly string[];
    /** Pretty-render (true) or JSON-render (false). Default: false. */
    pretty?: boolean;
}

function failure(code: string, message: string, exitCode: number): DispatchFailure {
    return {
        ok: false,
        exitCode,
        error: { code, message },
        rendered: formatError(code, message),
    };
}

async function dispatchCommand(
    engine: MemoryEngine,
    parsed: ParsedCommand,
    options: DispatchOptions = {},
): Promise<DispatchResult> {
    const { allow, pretty = false } = options;

    // Unknown and disallowed commands collapse to the same external code so
    // callers can't probe the allow-list by diffing error messages.
    const handler = COMMANDS[parsed.command];
    if (!handler || (allow && !allow.includes(parsed.command))) {
        return failure("COMMAND_NOT_ALLOWED", `Command not allowed: ${parsed.command}`, 2);
    }

    let result: CommandResult;
    try {
        result = await handler(engine, parsed);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failure("COMMAND_ERROR", message, 1);
    }

    // Preserve the cli.ts validation-error convention: a non-zero exitCode
    // with an {error: string} payload signals a handler-side validation failure.
    if (
        result.exitCode !== 0 &&
        result.output &&
        typeof result.output === "object" &&
        "error" in result.output &&
        typeof (result.output as { error: unknown }).error === "string"
    ) {
        return failure(
            "VALIDATION_ERROR",
            (result.output as { error: string }).error,
            result.exitCode,
        );
    }

    if (result.exitCode !== 0) {
        const rendered = formatOutput(
            result.formatCommand ?? parsed.command,
            result.output,
            pretty,
        );
        return failure("COMMAND_ERROR", rendered || "command failed", result.exitCode);
    }

    const rendered = formatOutput(result.formatCommand ?? parsed.command, result.output, pretty);
    return {
        ok: true,
        exitCode: 0,
        output: result.output,
        rendered,
        formatCommand: result.formatCommand,
    };
}

export { dispatchCommand, COMMANDS };
export type { DispatchResult, DispatchSuccess, DispatchFailure, DispatchOptions };
