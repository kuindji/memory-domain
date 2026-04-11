import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MemoryEngine } from "../../src/core/engine.js";
import { dispatchCommand, COMMANDS } from "../../src/serve/dispatch.js";
import type { ParsedCommand } from "../../src/cli/types.js";
import { MockLLMAdapter } from "../helpers.js";

function parsed(
    command: string,
    args: string[] = [],
    flags: Record<string, string | boolean | Record<string, string>> = {},
): ParsedCommand {
    return { command, args, flags };
}

describe("dispatchCommand", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_dispatch_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
    });

    afterAll(async () => {
        await engine.close();
    });

    it("rejects unknown command with COMMAND_NOT_ALLOWED", async () => {
        const result = await dispatchCommand(engine, parsed("nope"));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("COMMAND_NOT_ALLOWED");
        expect(result.exitCode).toBe(2);
        expect(result.rendered).toContain("COMMAND_NOT_ALLOWED");
    });

    it("rejects disallowed command with COMMAND_NOT_ALLOWED", async () => {
        const result = await dispatchCommand(engine, parsed("ingest"), {
            allow: ["search", "build-context"],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("COMMAND_NOT_ALLOWED");
        expect(result.exitCode).toBe(2);
    });

    it("runs allowed command successfully", async () => {
        const result = await dispatchCommand(engine, parsed("search", ["anything"]), {
            allow: ["search"],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.exitCode).toBe(0);
        expect(typeof result.rendered).toBe("string");
        expect(result.rendered.length).toBeGreaterThan(0);
        expect(result.output).toBeDefined();
    });

    it("runs command when no allow-list is set", async () => {
        const result = await dispatchCommand(engine, parsed("search", ["anything"]));
        expect(result.ok).toBe(true);
    });

    it("normalizes handler validation errors to VALIDATION_ERROR", async () => {
        // search.ts returns { output: { error: "..." }, exitCode: 1 } when text is missing
        const result = await dispatchCommand(engine, parsed("search", []));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toMatch(/required/i);
        expect(result.exitCode).toBe(1);
    });

    it("COMMANDS registry contains all documented read-only commands", () => {
        const readOnly = [
            "search",
            "build-context",
            "memory",
            "graph",
            "skill",
            "domains",
            "domain",
        ];
        for (const name of readOnly) {
            expect(COMMANDS[name]).toBeDefined();
        }
    });

    it("renders JSON envelope by default and pretty on opt-in", async () => {
        const json = await dispatchCommand(engine, parsed("search", ["anything"]));
        expect(json.ok).toBe(true);
        if (!json.ok) return;
        expect(json.rendered.startsWith("{")).toBe(true);

        const pretty = await dispatchCommand(engine, parsed("search", ["anything"]), {
            pretty: true,
        });
        expect(pretty.ok).toBe(true);
        if (!pretty.ok) return;
        expect(pretty.rendered).toContain("Found");
    });
});
