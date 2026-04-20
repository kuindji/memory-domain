import type { LLMAdapter, ModelLevel, ScoredMemory } from "../../core/types.js";
import { parseJsonResponse } from "./json-response.js";
import { runWithRetry } from "./retry.js";

export interface OpenAiHttpAdapterConfig {
    baseUrl: string;
    model: string;
    modelLevels?: Partial<Record<ModelLevel, string>>;
    apiKey?: string;
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
    retryBaseDelayMs?: number;
    headers?: Record<string, string>;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT = 120_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

interface ChatCompletionResponse {
    choices?: Array<{ message?: { content?: string } }>;
}

class OpenAiHttpAdapter implements LLMAdapter {
    private readonly originalConfig: OpenAiHttpAdapterConfig;
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly modelLevels: Partial<Record<ModelLevel, string>> | undefined;
    private readonly apiKey: string | undefined;
    private readonly maxTokens: number;
    private readonly temperature: number;
    private readonly timeout: number;
    private readonly retryBaseDelayMs: number | undefined;
    private readonly extraHeaders: Record<string, string>;

    constructor(config: OpenAiHttpAdapterConfig) {
        this.originalConfig = config;
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.model = config.model;
        this.modelLevels = config.modelLevels;
        this.apiKey = config.apiKey;
        this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.temperature = config.temperature ?? DEFAULT_TEMPERATURE;
        this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
        this.retryBaseDelayMs = config.retryBaseDelayMs;
        this.extraHeaders = config.headers ?? {};
    }

    withLevel(level: ModelLevel): LLMAdapter {
        const model = this.modelLevels?.[level] ?? this.model;
        return new OpenAiHttpAdapter({ ...this.originalConfig, model });
    }

    private isRetryable(err: unknown): boolean {
        if (err instanceof OpenAiHttpStatusError) {
            return RETRYABLE_STATUSES.has(err.status);
        }
        if (err instanceof TypeError) return true; // fetch network error
        if (err instanceof Error && err.name === "AbortError") return true;
        return false;
    }

    private async run(prompt: string): Promise<string> {
        return runWithRetry(() => this.runOnce(prompt), {
            isRetryable: (err) => this.isRetryable(err),
            label: "[OpenAI HTTP]",
            baseDelayMs: this.retryBaseDelayMs,
        });
    }

    private async runOnce(prompt: string): Promise<string> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...this.extraHeaders,
        };
        if (this.apiKey !== undefined && this.apiKey !== "") {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        try {
            const res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    stream: false,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const preview = (await res.text().catch(() => "")).slice(0, 500);
                throw new OpenAiHttpStatusError(res.status, preview);
            }

            const data = (await res.json()) as ChatCompletionResponse;
            const content = data.choices?.[0]?.message?.content;
            if (typeof content !== "string" || content.length === 0) {
                throw new Error(
                    `OpenAI HTTP response missing choices[0].message.content (model=${this.model})`,
                );
            }
            return content.trim();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async extract(text: string, prompt?: string): Promise<string[]> {
        const systemPrompt =
            prompt ??
            "Extract the key factual claims from the following text. Return a JSON array of strings, each being one atomic fact.";
        const fullPrompt = `${systemPrompt}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of strings.`;
        const response = await this.run(fullPrompt);
        return parseJsonResponse<string[]>(response);
    }

    async extractStructured(text: string, schema: string, prompt?: string): Promise<unknown[]> {
        const systemPrompt = prompt ?? "Extract structured information from the following text.";
        const fullPrompt = `${systemPrompt}\n\nExpected output schema for each item:\n${schema}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of objects matching the schema.`;
        const response = await this.run(fullPrompt);
        return parseJsonResponse<unknown[]>(response);
    }

    async consolidate(memories: string[]): Promise<string> {
        const memoryList = memories.map((m, i) => `${i + 1}. ${m}`).join("\n");
        const prompt = `Consolidate the following related memories into a single, comprehensive summary that preserves all important details:\n\n${memoryList}\n\nReturn ONLY the consolidated text (no JSON, no markdown).`;
        return this.run(prompt);
    }

    async assess(content: string, existingContext: string[]): Promise<number> {
        const contextBlock =
            existingContext.length > 0
                ? `\n\nExisting memories:\n${existingContext.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
                : "";
        const prompt = `Rate the novelty and importance of the following content on a scale from 0.0 to 1.0, where 0.0 means completely redundant/trivial and 1.0 means highly novel and important.${contextBlock}\n\nNew content: "${content}"\n\nReturn ONLY a JSON number between 0.0 and 1.0.`;
        const response = await this.run(prompt);
        const score = parseFloat(response.replace(/[^0-9.]/g, ""));
        return Math.max(0, Math.min(1, score));
    }

    async rerank(query: string, candidates: { id: string; content: string }[]): Promise<string[]> {
        const candidateList = candidates
            .map((c, i) => `[${i}] (id: ${c.id}) ${c.content}`)
            .join("\n");
        const prompt = `Given the query: "${query}"\n\nRerank these memory candidates by relevance. Return a JSON array of their IDs in order from most to least relevant.\n\nCandidates:\n${candidateList}\n\nReturn ONLY a JSON array of ID strings.`;
        const response = await this.run(prompt);
        return parseJsonResponse<string[]>(response);
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
        const fullPrompt = `${baseInstructions}\n\nQuery: "${query}"\n${tagBlock}\n\nRetrieved memories:\n${memoryList}`;
        return this.run(fullPrompt);
    }
}

class OpenAiHttpStatusError extends Error {
    constructor(
        public readonly status: number,
        public readonly bodyPreview: string,
    ) {
        super(`OpenAI HTTP endpoint returned ${status}: ${bodyPreview}`);
        this.name = "OpenAiHttpStatusError";
    }
}

export { OpenAiHttpAdapter };
