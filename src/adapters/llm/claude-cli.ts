/**
 * LLM adapter that uses the Claude CLI (`claude`) for all LLM operations.
 * Spawns a subprocess for each call — no API keys needed.
 */

import { spawn } from "node:child_process";
import type { LLMAdapter, ScoredMemory, ModelLevel } from "../../core/types.js";

interface ClaudeCliConfig {
    command?: string;
    model?: string;
    modelLevels?: Partial<Record<ModelLevel, string>>;
    maxTokens?: number;
    timeout?: number;
}

const DEFAULT_COMMAND = "claude";
const DEFAULT_TIMEOUT = 120_000;
const ERROR_OUTPUT_PREVIEW_LIMIT = 500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 30_000;

function compactOutput(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function previewOutput(text: string): string {
    const compacted = compactOutput(text);
    if (!compacted) return "";
    if (compacted.length <= ERROR_OUTPUT_PREVIEW_LIMIT) {
        return compacted;
    }
    return `${compacted.slice(0, ERROR_OUTPUT_PREVIEW_LIMIT)}...`;
}

class ClaudeCliAdapter implements LLMAdapter {
    private command: string;
    private model: string | undefined;
    private modelLevels: Partial<Record<ModelLevel, string>> | undefined;
    private maxTokens: number | undefined;
    private timeout: number;
    private originalConfig: ClaudeCliConfig | undefined;

    constructor(config?: ClaudeCliConfig) {
        this.originalConfig = config;
        this.command = config?.command ?? DEFAULT_COMMAND;
        this.model = config?.model;
        this.modelLevels = config?.modelLevels;
        this.maxTokens = config?.maxTokens;
        this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    }

    withLevel(level: ModelLevel): LLMAdapter {
        const model = this.modelLevels?.[level] ?? this.model;
        return new ClaudeCliAdapter({ ...this.originalConfig, model });
    }

    private isRetryable(errorMessage: string): boolean {
        return (
            errorMessage.includes("overloaded") ||
            errorMessage.includes("529") ||
            errorMessage.includes("timed out") ||
            errorMessage.includes("rate_limit") ||
            errorMessage.includes("503")
        );
    }

    private async run(prompt: string): Promise<string> {
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.log(
                    `[Claude CLI] Retry ${attempt}/${MAX_RETRIES} after ${delay / 1000}s...`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }

            try {
                return await this.runOnce(prompt);
            } catch (err) {
                lastError = err as Error;
                if (!this.isRetryable(lastError.message) || attempt === MAX_RETRIES) {
                    throw lastError;
                }
            }
        }

        throw lastError ?? new Error("Claude CLI failed after retries");
    }

    private async runOnce(prompt: string): Promise<string> {
        const args = ["--print"];
        if (this.model) {
            args.push("--model", this.model);
        }
        if (this.maxTokens) {
            args.push("--max-tokens", String(this.maxTokens));
        }

        const proc = spawn(this.command, args, {
            stdio: ["pipe", "pipe", "pipe"],
        });

        proc.stdin.end(prompt);

        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            proc.kill();
        }, this.timeout);

        const collectStream = (stream: NodeJS.ReadableStream): Promise<string> =>
            new Promise((resolve) => {
                const chunks: Buffer[] = [];
                stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
            });

        const exitCodePromise = new Promise<number>((resolve) => {
            proc.on("close", (code) => resolve(code ?? 1));
        });

        try {
            const [output, stderr, exitCode] = await Promise.all([
                collectStream(proc.stdout),
                collectStream(proc.stderr),
                exitCodePromise,
            ]);
            clearTimeout(timeoutId);

            if (timedOut) {
                const stderrPreview = previewOutput(stderr);
                const stdoutPreview = previewOutput(output);
                const details = [
                    `Claude CLI timed out after ${this.timeout}ms`,
                    this.model ? `model=${this.model}` : undefined,
                    `promptChars=${prompt.length}`,
                    stderrPreview ? `stderr=${JSON.stringify(stderrPreview)}` : undefined,
                    stdoutPreview ? `stdout=${JSON.stringify(stdoutPreview)}` : undefined,
                ].filter((value): value is string => value !== undefined);
                throw new Error(details.join(" "));
            }

            if (exitCode !== 0) {
                const stderrPreview = previewOutput(stderr);
                const stdoutPreview = previewOutput(output);
                const details = [
                    `Claude CLI exited with code ${exitCode}`,
                    this.model ? `model=${this.model}` : undefined,
                    `promptChars=${prompt.length}`,
                    stderrPreview ? `stderr=${JSON.stringify(stderrPreview)}` : undefined,
                    stdoutPreview ? `stdout=${JSON.stringify(stdoutPreview)}` : undefined,
                ].filter((value): value is string => value !== undefined);
                throw new Error(details.join(" "));
            }

            return output.trim();
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    }

    private parseJsonResponse<T>(text: string): T {
        const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        const jsonStr = jsonMatch ? jsonMatch[1] : text;
        return JSON.parse(jsonStr) as T;
    }

    async extractStructured(text: string, schema: string, prompt?: string): Promise<unknown[]> {
        const systemPrompt = prompt ?? "Extract structured information from the following text.";

        const fullPrompt = `${systemPrompt}\n\nExpected output schema for each item:\n${schema}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of objects matching the schema.`;
        const response = await this.run(fullPrompt);
        return this.parseJsonResponse<unknown[]>(response);
    }

    async extract(text: string, prompt?: string): Promise<string[]> {
        const systemPrompt =
            prompt ??
            "Extract the key factual claims from the following text. Return a JSON array of strings, each being one atomic fact.";

        const fullPrompt = `${systemPrompt}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of strings.`;
        const response = await this.run(fullPrompt);
        return this.parseJsonResponse<string[]>(response);
    }

    async assess(content: string, existingContext: string[]): Promise<number> {
        const contextBlock =
            existingContext.length > 0
                ? `\n\nExisting memories:\n${existingContext.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
                : "";

        const prompt = `Rate the novelty and importance of the following content on a scale from 0.0 to 1.0, where 0.0 means completely redundant/trivial and 1.0 means highly novel and important.${contextBlock}

New content: "${content}"

Return ONLY a JSON number between 0.0 and 1.0.`;

        const response = await this.run(prompt);
        const score = parseFloat(response.replace(/[^0-9.]/g, ""));
        return Math.max(0, Math.min(1, score));
    }

    async rerank(query: string, candidates: { id: string; content: string }[]): Promise<string[]> {
        const candidateList = candidates
            .map((c, i) => `[${i}] (id: ${c.id}) ${c.content}`)
            .join("\n");

        const prompt = `Given the query: "${query}"

Rerank these memory candidates by relevance. Return a JSON array of their IDs in order from most to least relevant.

Candidates:
${candidateList}

Return ONLY a JSON array of ID strings.`;

        const response = await this.run(prompt);
        return this.parseJsonResponse<string[]>(response);
    }

    async consolidate(memories: string[]): Promise<string> {
        const memoryList = memories.map((m, i) => `${i + 1}. ${m}`).join("\n");

        const prompt = `Consolidate the following related memories into a single, comprehensive summary that preserves all important details:

${memoryList}

Return ONLY the consolidated text (no JSON, no markdown).`;

        return this.run(prompt);
    }

    async generate(prompt: string): Promise<string> {
        return this.run(prompt);
    }

    async synthesize(
        query: string,
        memories: ScoredMemory[],
        tagContext?: string[],
        instructions?: string,
    ): Promise<string> {
        const memoryList = memories
            .map((m, i) => `[${i + 1}] (score: ${m.score.toFixed(3)}) ${m.content}`)
            .join("\n");

        const tagBlock = tagContext?.length
            ? `\nRelevant context tags: ${tagContext.join(", ")}`
            : "";

        const baseInstructions =
            instructions ??
            "Answer the following query using ONLY the retrieved memories below.\nBe direct and concise. Cover all relevant points from the memories without adding speculation or information not present in the memories.\nIf the memories don't contain enough information to fully answer, state what's missing rather than guessing.";

        const prompt = `${baseInstructions}

Query: "${query}"
${tagBlock}

Retrieved memories:
${memoryList}`;

        return this.run(prompt);
    }
}

export { ClaudeCliAdapter };
export type { ClaudeCliConfig };
