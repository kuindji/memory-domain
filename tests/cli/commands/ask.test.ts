import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryEngine } from "../../../src/core/engine.js";
import { MockLLMAdapter } from "../../helpers.js";
import { askCommand } from "../../../src/cli/commands/ask.js";
import type { ParsedCommand } from "../../../src/cli/types.js";
import type { AskResult } from "../../../src/core/types.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeParsed(args: string[], flags: Record<string, string | boolean> = {}): ParsedCommand {
    return {
        command: "ask",
        args,
        flags: { ...flags },
    };
}

describe("askCommand", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ask-cmd-"));
        mkdirSync(join(tmpDir, "skills"), { recursive: true });
        writeFileSync(join(tmpDir, "skills", "ask.md"), "Test domain skill.");

        llm = new MockLLMAdapter();
        llm.agentAnswer = "Final answer";

        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_ask_cmd_${Date.now()}`,
            llm,
        });
        await engine.registerDomain({
            id: "test",
            name: "Test",
            baseDir: tmpDir,
            async processInboxBatch() {},
        });
    });

    afterEach(async () => {
        await engine.close();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns error when no question is provided", async () => {
        const result = await askCommand(engine, makeParsed([]));
        expect(result.exitCode).toBe(1);
        expect((result.output as { error: string }).error).toBe("Question is required.");
    });

    it("returns an answer when passed a single domain", async () => {
        const result = await askCommand(
            engine,
            makeParsed(["What is the fox doing?"], { domains: "test" }),
        );
        expect(result.exitCode).toBe(0);
        const output = result.output as AskResult;
        expect(output.answer).toBe("Final answer");
        expect(typeof output.rounds).toBe("number");
    });

    it("result has answer and rounds fields", async () => {
        const result = await askCommand(
            engine,
            makeParsed(["Tell me about meetings"], { domains: "test" }),
        );
        expect(result.exitCode).toBe(0);
        const output = result.output as AskResult;
        expect("answer" in output).toBe(true);
        expect("rounds" in output).toBe(true);
    });

    it("passes domains flag to engine", async () => {
        const result = await askCommand(
            engine,
            makeParsed(["What happened?"], { domains: "test" }),
        );
        expect(result.exitCode).toBe(0);
        expect(llm.lastAgentSpec?.question).toBe("What happened?");
    });

    it("passes budget flag to engine", async () => {
        const result = await askCommand(
            engine,
            makeParsed(["What happened?"], { domains: "test", budget: "4000" }),
        );
        expect(result.exitCode).toBe(0);
        expect(llm.lastAgentSpec?.budgetTokens).toBe(4000);
    });
});
