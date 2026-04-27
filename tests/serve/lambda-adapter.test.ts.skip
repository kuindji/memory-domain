import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MemoryEngine } from "../../src/core/engine.js";
import { createLambdaAdapter, READ_ONLY_COMMANDS } from "../../src/serve/lambda-adapter.js";
import { COMMANDS } from "../../src/serve/dispatch.js";
import type { LambdaInvocation } from "../../src/serve/lambda-adapter.js";
import { MockLLMAdapter } from "../helpers.js";

describe("createLambdaAdapter", () => {
    let engine: MemoryEngine;

    beforeAll(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_lambda_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
    });

    afterAll(async () => {
        await engine.close();
    });

    it("handles a search invocation under the default read-only profile", async () => {
        const handler = createLambdaAdapter(engine);
        const result = await handler({ command: "search", args: ["anything"] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(typeof result.rendered).toBe("string");
        expect(result.output).toBeDefined();
    });

    it("rejects write-side commands under the default read-only profile", async () => {
        const handler = createLambdaAdapter(engine);
        const result = await handler({ command: "ingest", args: ["some text"] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("COMMAND_NOT_ALLOWED");
    });

    it("full profile routes every command through the dispatcher", async () => {
        const handler = createLambdaAdapter(engine, { profile: "full" });
        // search requires a positional arg; passing it reaches the handler
        const ok = await handler({ command: "search", args: ["anything"] });
        expect(ok.ok).toBe(true);
        // with an unknown command it's still rejected, but via the allow-less path
        const unknown = await handler({ command: "nope", args: [] });
        expect(unknown.ok).toBe(false);
    });

    it("custom allow list overrides the profile", async () => {
        const handler = createLambdaAdapter(engine, { profile: ["search"] });
        const allowed = await handler({ command: "search", args: ["anything"] });
        expect(allowed.ok).toBe(true);
        const denied = await handler({ command: "memory", args: ["get", "nope"] });
        expect(denied.ok).toBe(false);
        if (denied.ok) return;
        expect(denied.error.code).toBe("COMMAND_NOT_ALLOWED");
    });

    it("rejects invalid payload shapes", async () => {
        const handler = createLambdaAdapter(engine);
        const empty = await handler({} as unknown as LambdaInvocation);
        expect(empty.ok).toBe(false);
        if (empty.ok) return;
        expect(empty.error.code).toBe("INVALID_PAYLOAD");

        const emptyCommand = await handler({ command: "", args: [] });
        expect(emptyCommand.ok).toBe(false);
        if (emptyCommand.ok) return;
        expect(emptyCommand.error.code).toBe("INVALID_PAYLOAD");

        const missingArgs = await handler({ command: "search" } as unknown as LambdaInvocation);
        expect(missingArgs.ok).toBe(false);
        if (missingArgs.ok) return;
        expect(missingArgs.error.code).toBe("INVALID_PAYLOAD");
    });

    it("rejects the help command", async () => {
        const handler = createLambdaAdapter(engine);
        const result = await handler({ command: "help", args: [] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("COMMAND_NOT_ALLOWED");
    });

    it("does not close the engine between invocations", async () => {
        const handler = createLambdaAdapter(engine);
        await handler({ command: "search", args: ["a"] });
        await handler({ command: "search", args: ["b"] });
        // Engine must still be usable directly
        const direct = await engine.search({ text: "c" });
        expect(direct).toBeDefined();
    });

    it("READ_ONLY_COMMANDS all resolve to real handlers", () => {
        for (const name of READ_ONLY_COMMANDS) {
            expect(COMMANDS[name]).toBeDefined();
        }
    });
});
