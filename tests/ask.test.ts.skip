import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import { MockLLMAdapter } from "./helpers.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("MemoryEngine.ask", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ask-test-"));
        mkdirSync(join(tmpDir, "skills"), { recursive: true });
        writeFileSync(
            join(tmpDir, "skills", "ask.md"),
            "You are a test-domain agent. Answer the question.",
        );

        llm = new MockLLMAdapter();
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_ask_${Date.now()}`,
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

    test("returns the agent's final answer", async () => {
        llm.agentAnswer = "TypeScript adds static types to JavaScript.";
        const result = await engine.ask("What is TypeScript?", {
            domains: ["test"],
            cache: false,
        });
        expect(result.answer).toBe("TypeScript adds static types to JavaScript.");
        expect(result.rounds).toBe(1);
        expect(result.turns).toEqual([]);
    });

    test("loads the domain's ask.md skill as the agent system prompt", async () => {
        llm.agentAnswer = "ok";
        await engine.ask("probe", { domains: ["test"], cache: false });
        expect(llm.lastAgentSpec?.skill).toContain("test-domain agent");
    });

    test("surfaces tool-call turns the agent made", async () => {
        llm.agentToolCalls = [["domains"]];
        llm.agentAnswer = "used the CLI";
        const result = await engine.ask("which domains?", {
            domains: ["test"],
            cache: false,
        });
        expect(result.turns?.length).toBe(1);
        expect(result.turns?.[0]?.call.args).toEqual(["domains"]);
        expect(result.turns?.[0]?.result.exitCode).toBe(0);
    });

    test("refuses recursive ask inside the agent loop", async () => {
        llm.agentToolCalls = [["ask", "nested?", "--domains", "test"]];
        llm.agentAnswer = "done";
        const result = await engine.ask("top", { domains: ["test"], cache: false });
        expect(result.turns?.[0]?.result.exitCode).toBe(2);
        expect(result.turns?.[0]?.result.stderr).toContain("ask is not available");
    });

    test("requires exactly one target domain", async () => {
        await expect(engine.ask("q", { domains: [] })).rejects.toThrow(/exactly one/);
        await expect(engine.ask("q", { domains: ["a", "b"] })).rejects.toThrow(/exactly one/);
    });
});
