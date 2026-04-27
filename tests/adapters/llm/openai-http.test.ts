import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { OpenAiHttpAdapter } from "../../../src/adapters/llm/openai-http.js";

interface CapturedRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
}

let server: Server<undefined>;
let baseUrl: string;
let captured: CapturedRequest[] = [];
let nextResponse: { status: number; body: unknown } = {
    status: 200,
    body: { choices: [{ message: { content: "" } }] },
};
let responseQueue: Array<{ status: number; body: unknown }> = [];

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => {
                headers[k] = v;
            });
            const body = await req.json().catch(() => null);
            captured.push({ method: req.method, path: url.pathname, headers, body });
            const responder = responseQueue.shift() ?? nextResponse;
            return new Response(JSON.stringify(responder.body), {
                status: responder.status,
                headers: { "Content-Type": "application/json" },
            });
        },
    });
    baseUrl = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
    server.stop(true);
});

function reset(): void {
    captured = [];
    responseQueue = [];
    nextResponse = { status: 200, body: { choices: [{ message: { content: "" } }] } };
}

function replyWith(content: string): void {
    nextResponse = { status: 200, body: { choices: [{ message: { content } }] } };
}

describe("OpenAiHttpAdapter.extract", () => {
    it("posts to /chat/completions with the configured model and parses a JSON array", async () => {
        reset();
        replyWith(`["Alice moved to Paris", "The deadline is Friday"]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "qwen2.5-3b" });

        const facts = await adapter.extract("Alice moved to Paris on Friday.");

        expect(facts).toEqual(["Alice moved to Paris", "The deadline is Friday"]);
        expect(captured).toHaveLength(1);
        const req0 = captured[0];
        expect(req0.method).toBe("POST");
        expect(req0.path).toBe("/v1/chat/completions");
        const body = req0.body as {
            model: string;
            messages: Array<{ role: string; content: string }>;
            stream: boolean;
        };
        expect(body.model).toBe("qwen2.5-3b");
        expect(body.stream).toBe(false);
        expect(body.messages).toHaveLength(1);
        const msg0 = body.messages[0] as { role: string; content: string };
        expect(msg0.role).toBe("user");
        expect(msg0.content).toContain("Alice moved to Paris on Friday.");
    });
});

describe("OpenAiHttpAdapter.extractStructured", () => {
    it("parses a JSON array of objects from a fenced code block response", async () => {
        reset();
        replyWith('```json\n[{"name":"Alice","city":"Paris"}]\n```');
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        const rows = await adapter.extractStructured("irrelevant", "{name,city}");
        expect(rows).toEqual([{ name: "Alice", city: "Paris" }]);
    });
});

describe("OpenAiHttpAdapter.rerank", () => {
    it("returns IDs in the model's returned order", async () => {
        reset();
        replyWith(`["b","a","c"]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        const order = await adapter.rerank("query", [
            { id: "a", content: "A" },
            { id: "b", content: "B" },
            { id: "c", content: "C" },
        ]);
        expect(order).toEqual(["b", "a", "c"]);
    });
});

describe("OpenAiHttpAdapter.assess", () => {
    it("parses a numeric response and clamps to [0,1]", async () => {
        reset();
        replyWith("0.73");
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        expect(await adapter.assess("new content", [])).toBeCloseTo(0.73);

        reset();
        replyWith("1.5");
        expect(await adapter.assess("x", [])).toBe(1);

        reset();
        replyWith("-0.2");
        expect(await adapter.assess("x", [])).toBe(0);
    });
});

describe("OpenAiHttpAdapter.withLevel", () => {
    it("sends the mapped model id for the requested level", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({
            baseUrl,
            model: "default-model",
            modelLevels: { low: "tiny", high: "big" },
        });
        await adapter.withLevel!("high").extract!("anything");
        const req0 = captured[0];
        const body = req0.body as { model: string };
        expect(body.model).toBe("big");
    });

    it("falls back to the base model when the level has no mapping", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({
            baseUrl,
            model: "default-model",
            modelLevels: { low: "tiny" },
        });
        await adapter.withLevel!("medium").extract!("anything");
        const req0 = captured[0];
        const body = req0.body as { model: string };
        expect(body.model).toBe("default-model");
    });
});

describe("OpenAiHttpAdapter auth headers", () => {
    it("sends Authorization: Bearer <apiKey> when apiKey is set", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m", apiKey: "lm-studio" });
        await adapter.extract("x");
        const req0 = captured[0];
        expect(req0.headers["authorization"]).toBe("Bearer lm-studio");
    });

    it("omits Authorization when apiKey is undefined", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m" });
        await adapter.extract("x");
        const req0 = captured[0];
        expect(req0.headers["authorization"]).toBeUndefined();
    });

    it("merges extra headers", async () => {
        reset();
        replyWith(`[]`);
        const adapter = new OpenAiHttpAdapter({
            baseUrl,
            model: "m",
            headers: { "X-Trace": "abc" },
        });
        await adapter.extract("x");
        const req0 = captured[0];
        expect(req0.headers["x-trace"]).toBe("abc");
    });
});

describe("OpenAiHttpAdapter retry behavior", () => {
    it("retries on 503 then succeeds when the server recovers", async () => {
        reset();
        responseQueue.push({ status: 503, body: { error: "overloaded" } });
        responseQueue.push({ status: 503, body: { error: "overloaded" } });
        responseQueue.push({
            status: 200,
            body: { choices: [{ message: { content: `["ok"]` } }] },
        });

        const adapter = new OpenAiHttpAdapter({
            baseUrl,
            model: "m",
            retryBaseDelayMs: 1,
        });
        const result = await adapter.extract("x");

        expect(result).toEqual(["ok"]);
        expect(captured).toHaveLength(3);
    }, 10_000);

    it("throws immediately on a non-retryable 400", async () => {
        reset();
        nextResponse = { status: 400, body: { error: "bad request" } };
        const adapter = new OpenAiHttpAdapter({ baseUrl, model: "m", retryBaseDelayMs: 1 });
        let caught: unknown;
        try {
            await adapter.extract("x");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("400");
        expect(captured).toHaveLength(1);
    });
});

describe("OpenAiHttpAdapter timeout", () => {
    it("throws when the server hangs past the configured timeout", async () => {
        const hangServer = Bun.serve({
            port: 0,
            async fetch() {
                await new Promise(() => {}); // never resolves
                return new Response();
            },
        });
        try {
            const adapter = new OpenAiHttpAdapter({
                baseUrl: `http://localhost:${hangServer.port}/v1`,
                model: "m",
                timeout: 50,
                retryBaseDelayMs: 1,
            });
            let caught: unknown;
            try {
                await adapter.extract("x");
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeInstanceOf(Error);
        } finally {
            hangServer.stop(true);
        }
    });
});
