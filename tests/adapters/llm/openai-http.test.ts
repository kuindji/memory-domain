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
            return new Response(JSON.stringify(nextResponse.body), {
                status: nextResponse.status,
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
