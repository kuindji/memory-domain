import type { AgentRunSpec, AgentRunResult, AgentRunTurn } from "../../core/types.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Adapter-agnostic JSON-mode agent loop. Each turn: send all messages so far
 * to `chat`, parse reply as {"tool":"cli","args":[...]} or {"answer":"..."},
 * dispatch tool calls via spec.toolExec, feed stdout/stderr back as a user
 * message, repeat until answer or maxTurns.
 */
async function runJsonAgentLoop(
    spec: AgentRunSpec,
    chat: (messages: ChatMessage[]) => Promise<string>,
): Promise<AgentRunResult> {
    const maxTurns = spec.maxTurns ?? 12;
    const messages: ChatMessage[] = [
        { role: "system", content: buildAgentSystemPrompt(spec.skill) },
        {
            role: "user",
            content: [
                `Question: ${spec.question}`,
                "",
                'Your next reply must be a tool call in the form {"tool":"cli","args":[...]}. Do NOT answer yet — you have no data. Pick one of the allowed subcommands and retrieve what you need.',
            ].join("\n"),
        },
    ];

    const debug = process.env["DEBUG_AGENT_LOOP"] === "1";
    const turns: AgentRunTurn[] = [];
    for (let i = 0; i < maxTurns; i++) {
        const reply = await chat(messages);
        if (debug) {
            console.error(`[agent-loop turn ${i}] reply: ${reply.slice(0, 400)}`);
        }
        const parsed = parseAgentReply(reply);
        if (parsed.kind === "answer") {
            if (turns.length === 0) {
                // Hard rule: at least one tool call before answering.
                messages.push({ role: "assistant", content: reply });
                messages.push({
                    role: "user",
                    content:
                        'You answered without calling any tool. That violates rule 1: the first reply must be a tool call. Respond with {"tool":"cli","args":[...]} now.',
                });
                continue;
            }
            return { answer: parsed.answer, turns };
        }
        if (parsed.kind === "error") {
            messages.push({ role: "assistant", content: reply });
            messages.push({
                role: "user",
                content: `Your previous reply was not valid JSON. Respond with ONLY one JSON object of shape {"tool":"cli","args":[...]} OR {"answer":"..."}. Error: ${parsed.error}`,
            });
            continue;
        }
        messages.push({ role: "assistant", content: reply });
        const callResult = await spec.toolExec({
            command: "memory-domain",
            args: parsed.args,
        });
        turns.push({
            call: { command: "memory-domain", args: parsed.args },
            result: callResult,
        });
        // Detect and short-circuit same-call-retry-on-error — a common failure
        // mode for small models when they don't learn from error messages.
        const repeatCount = turns.filter(
            (t) =>
                t.result.exitCode !== 0 &&
                JSON.stringify(t.call.args) === JSON.stringify(parsed.args),
        ).length;
        const retryHint =
            repeatCount >= 2 && callResult.exitCode !== 0
                ? "\n\nSTOP. You have repeated this failing call. Change your approach — try `list_indicators` to discover the right indicator code, or switch country codes to ISO-3 (USA/JPN/DEU/CHN, not US/JP/DE/CN)."
                : "";
        const toolMessage = [
            `exit=${callResult.exitCode}`,
            callResult.stdout ? `stdout:\n${truncate(callResult.stdout, 4000)}` : "stdout: (empty)",
            callResult.stderr ? `stderr:\n${truncate(callResult.stderr, 1000)}` : "",
            retryHint,
        ]
            .filter(Boolean)
            .join("\n");
        messages.push({ role: "user", content: toolMessage });
    }

    const callSummary = turns
        .map((t, i) => `  ${i + 1}. exit=${t.result.exitCode} args=${t.call.args.join(" ")}`)
        .join("\n");
    throw new Error(
        `runAgent exceeded maxTurns=${maxTurns} without producing a final answer.\nCalls so far (${turns.length}):\n${callSummary || "  (none)"}`,
    );
}

function buildAgentSystemPrompt(skill: string): string {
    return [
        skill,
        "",
        "## Protocol",
        "Each reply must be EXACTLY one JSON object, no prose around it:",
        '  Call a tool:  {"tool":"<subcommand>","args":["<arg1>","<arg2>", ...]}  (runs `memory-domain <subcommand> <arg1> <arg2> ...`)',
        '  Final answer: {"answer":"<final prose answer>"}                          (ends the loop)',
        "",
        "Country codes are always **ISO-3** (USA, JPN, DEU, CHN, BRA, ARG) — never ISO-2 (US, JP, DE). The CLI rejects ISO-2 with an error.",
        "`args` is a FLAT ARRAY OF STRINGS — the shell argv. JSON filter/params objects must be serialized as a single string with the JSON embedded and properly escaped.",
        'Good example:  {"tool":"search-table","args":["financial","--filter","{\\"countries\\":[\\"USA\\"],\\"indicators\\":[\\"NY.GDP.MKTP.KD.ZG\\"],\\"yearRange\\":{\\"from\\":2005,\\"to\\":2005}}"]}',
        'Good example:  {"tool":"run-template","args":["financial","macro_snapshot","--params","{\\"country\\":\\"USA\\",\\"year\\":2005}"]}',
        'Bad  example:  {"tool":"search-table","args":["financial","countries":["USA"]]} — args must not contain bare JSON fragments, only strings.',
        "",
        "## Hard rules",
        "1. Your FIRST reply MUST be a tool call, never an answer. You have no data yet — retrieve some.",
        "2. Every number in the final answer must appear in a tool result you received this loop. Do not answer numbers from general knowledge; they will be wrong for this domain.",
        "3. Do not emit the final answer until at least one tool call has returned non-empty `stdout` containing data relevant to the question.",
        "4. Allowed subcommands: search, search-table, run-template, build-context, memory, domain, domains, skill, core-memory. `ask` is forbidden.",
        "5. After each tool call you receive a user message with stdout/stderr — use it to plan the next step.",
        '6. Keep tool calls focused (usually ≤6 total). When you have enough data, emit the final {"answer":...} object.',
    ].join("\n");
}

type AgentReply =
    | { kind: "tool"; args: string[] }
    | { kind: "answer"; answer: string }
    | { kind: "error"; error: string };

function parseAgentReply(reply: string): AgentReply {
    const stripped = stripCodeFences(reply).trim();
    // If the model wrapped the JSON in prose, try to pull out the first {...} block.
    let candidate = stripped;
    if (!candidate.startsWith("{")) {
        const m = candidate.match(/\{[\s\S]*\}/);
        if (m) candidate = m[0];
    }
    let obj: unknown;
    try {
        obj = JSON.parse(candidate);
    } catch (err) {
        return { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (!obj || typeof obj !== "object") {
        return { kind: "error", error: "reply was not a JSON object" };
    }
    const o = obj as Record<string, unknown>;
    if (typeof o["answer"] === "string") {
        return { kind: "answer", answer: o["answer"] };
    }
    if (typeof o["tool"] === "string" && Array.isArray(o["args"])) {
        const tool = o["tool"];
        const rawArgs = (o["args"] as unknown[]).map((a) => String(a));
        // Accept both protocol shapes:
        //   {"tool":"cli","args":["<subcommand>", ...]}   — documented
        //   {"tool":"<subcommand>","args":[...]}          — natural shape Qwen emits
        const args = tool === "cli" ? rawArgs : [tool, ...rawArgs];
        if (args.length === 0) {
            return { kind: "error", error: "tool call missing args" };
        }
        return { kind: "tool", args };
    }
    return {
        kind: "error",
        error: 'reply must have "answer" string or {"tool":"...","args":[...]}',
    };
}

function stripCodeFences(text: string): string {
    const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return fenceMatch ? fenceMatch[1] : text;
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

export { runJsonAgentLoop };
export type { ChatMessage };
