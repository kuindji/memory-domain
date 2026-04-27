import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryEngine } from "../../../src/core/engine.js";
import { MockLLMAdapter } from "../../helpers.js";
import { buildContextCommand } from "../../../src/cli/commands/build-context.js";
import type { ParsedCommand } from "../../../src/cli/types.js";
import type { ContextResult } from "../../../src/core/types.js";

function makeParsed(args: string[], flags: Record<string, string | boolean> = {}): ParsedCommand {
    return {
        command: "build-context",
        args,
        flags: { ...flags },
    };
}

describe("buildContextCommand", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_build_context_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain({
            id: "test",
            name: "Test",
            async processInboxBatch() {},
        });

        await engine.ingest("The quick brown fox jumps over the lazy dog", { domains: ["test"] });
        await engine.ingest("Meeting notes for project kickoff on monday", { domains: ["test"] });
        await engine.ingest("Shopping list: milk, eggs, bread", { domains: ["test"] });
    });

    afterEach(async () => {
        await engine.close();
    });

    it("returns error when no text is provided", async () => {
        const result = await buildContextCommand(engine, makeParsed([]));
        expect(result.exitCode).toBe(1);
        expect((result.output as { error: string }).error).toBe("Text is required.");
    });

    it("returns result for valid text", async () => {
        const result = await buildContextCommand(engine, makeParsed(["fox"]));
        expect(result.exitCode).toBe(0);
    });

    it("result has context, memories, and totalTokens fields", async () => {
        const result = await buildContextCommand(engine, makeParsed(["meeting"]));
        expect(result.exitCode).toBe(0);
        const output = result.output as ContextResult;
        expect("context" in output).toBe(true);
        expect("memories" in output).toBe(true);
        expect("totalTokens" in output).toBe(true);
        expect(typeof output.context).toBe("string");
        expect(Array.isArray(output.memories)).toBe(true);
        expect(typeof output.totalTokens).toBe("number");
    });

    it("falls back to --text flag when no positional arg", async () => {
        const result = await buildContextCommand(engine, makeParsed([], { text: "fox" }));
        expect(result.exitCode).toBe(0);
    });

    it("falls back to --query flag when no positional arg", async () => {
        const result = await buildContextCommand(engine, makeParsed([], { query: "fox" }));
        expect(result.exitCode).toBe(0);
    });

    it("positional arg takes precedence over --text flag", async () => {
        const result = await buildContextCommand(engine, makeParsed(["meeting"], { text: "fox" }));
        expect(result.exitCode).toBe(0);
    });

    it("respects budget flag", async () => {
        // Ingest more memories to ensure there's something to limit
        for (let i = 0; i < 5; i++) {
            await engine.ingest(`Extra memory entry number ${i} with extra content`, {
                domains: ["test"],
            });
        }

        const resultLarge = await buildContextCommand(
            engine,
            makeParsed(["memory"], { budget: "10000" }),
        );
        const resultSmall = await buildContextCommand(
            engine,
            makeParsed(["memory"], { budget: "1" }),
        );

        expect(resultLarge.exitCode).toBe(0);
        expect(resultSmall.exitCode).toBe(0);

        const large = resultLarge.output as ContextResult;
        const small = resultSmall.output as ContextResult;
        expect(small.memories.length).toBeLessThanOrEqual(large.memories.length);
    });

    it("passes domains flag to engine", async () => {
        const result = await buildContextCommand(engine, makeParsed(["fox"], { domains: "test" }));
        expect(result.exitCode).toBe(0);
        const output = result.output as ContextResult;
        expect(Array.isArray(output.memories)).toBe(true);
    });
});
