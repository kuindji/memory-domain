import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { StringRecordId } from "surrealdb";
import { MemoryEngine } from "../../../src/core/engine.js";
import { MockLLMAdapter } from "../../helpers.js";
import { ingestCommand } from "../../../src/cli/commands/ingest.js";
import type { ParsedCommand } from "../../../src/cli/types.js";

function makeParsed(flags: Record<string, string | boolean> = {}): ParsedCommand {
    return {
        command: "ingest",
        args: [],
        flags: { ...flags },
    };
}

describe("ingestCommand", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_ingest_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain({
            id: "test",
            name: "Test",
            async processInboxBatch() {},
        });
    });

    afterEach(async () => {
        await engine.close();
    });

    it("ingests with --text flag and returns stored action", async () => {
        const parsed = makeParsed({ text: "Hello world memory", domains: "test" });
        const result = await ingestCommand(engine, parsed);

        expect(result.exitCode).toBe(0);
        const output = result.output as { action: string; id?: string };
        expect(output.action).toBe("stored");
        expect(output.id).toBeTruthy();
    });

    it("returns stored memory that can be retrieved from the graph", async () => {
        const parsed = makeParsed({ text: "Verifiable memory content", domains: "test" });
        const result = await ingestCommand(engine, parsed);

        expect(result.exitCode).toBe(0);
        const output = result.output as { action: string; id?: string };
        const node = await engine.getGraph().getNode(output.id!);
        expect(node).not.toBeNull();
        expect(node!.content).toBe("Verifiable memory content");
    });

    it("passes domains flag to the engine", async () => {
        const parsed = makeParsed({ text: "Domain-scoped memory", domains: "work,personal" });
        const result = await ingestCommand(engine, parsed);

        expect(result.exitCode).toBe(0);
        const output = result.output as { action: string; id?: string };
        expect(output.action).toBe("stored");

        const owners = await engine
            .getGraph()
            .query<
                { out: string }[]
            >("SELECT out FROM owned_by WHERE in = $id", { id: new StringRecordId(output.id!) });
        const domainIds = (owners ?? []).map((o) => String(o.out));
        expect(domainIds).toContain("domain:work");
        expect(domainIds).toContain("domain:personal");
    });

    it("passes tags flag to the engine", async () => {
        const parsed = makeParsed({
            text: "Tagged memory content",
            tags: "shopping,todo",
            domains: "test",
        });
        const result = await ingestCommand(engine, parsed);

        expect(result.exitCode).toBe(0);
        const output = result.output as { action: string; id?: string };
        expect(output.action).toBe("stored");

        const tagged = await engine
            .getGraph()
            .query<
                { out: string }[]
            >("SELECT out FROM tagged WHERE in = $id", { id: new StringRecordId(output.id!) });
        const tagIds = (tagged ?? []).map((t) => String(t.out));
        expect(tagIds).toContain("tag:shopping");
        expect(tagIds).toContain("tag:todo");
    });

    it("returns error when no text and stdin is TTY", async () => {
        // In test runner process.stdin.isTTY is true, so no text + no pipe = error
        const parsed = makeParsed();
        const result = await ingestCommand(engine, parsed);

        expect(result.exitCode).toBe(1);
        const output = result.output as { error: string };
        expect(output.error).toMatch(/No input text/);
    });
});
