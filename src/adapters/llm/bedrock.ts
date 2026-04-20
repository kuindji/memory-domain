import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import {
    APIConnectionError,
    APIError,
    InternalServerError,
    RateLimitError,
} from "@anthropic-ai/sdk";
import { fromIni } from "@aws-sdk/credential-providers";
import type {
    BedrockAdapterConfig,
    LLMAdapter,
    ModelLevel,
    ScoredMemory,
} from "../../core/types.js";
import { parseJsonResponse } from "./json-response.js";
import { runWithRetry } from "./retry.js";

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

class BedrockAdapter implements LLMAdapter {
    private client: AnthropicBedrock;
    private modelId: string;
    private modelLevels: Partial<Record<ModelLevel, string>> | undefined;
    private maxTokens: number;
    private timeout: number;
    private originalConfig: BedrockAdapterConfig;

    constructor(config: BedrockAdapterConfig) {
        this.originalConfig = config;
        this.modelId = config.modelId;
        this.modelLevels = config.modelLevels;
        this.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
        this.client = BedrockAdapter.buildClient(config);
    }

    private static buildClient(config: BedrockAdapterConfig): AnthropicBedrock {
        if (config.credentials) {
            return new AnthropicBedrock({
                awsRegion: config.region,
                awsAccessKey: config.credentials.accessKeyId,
                awsSecretKey: config.credentials.secretAccessKey,
                awsSessionToken: config.credentials.sessionToken ?? null,
            });
        }
        if (config.profile) {
            const profile = config.profile;
            return new AnthropicBedrock({
                awsRegion: config.region,
                providerChainResolver: () => Promise.resolve(fromIni({ profile })),
            });
        }
        return new AnthropicBedrock({ awsRegion: config.region });
    }

    withLevel(level: ModelLevel): LLMAdapter {
        const modelId = this.modelLevels?.[level] ?? this.modelId;
        return new BedrockAdapter({ ...this.originalConfig, modelId });
    }

    private isRetryable(err: unknown): boolean {
        if (err instanceof APIConnectionError) return true;
        if (err instanceof RateLimitError) return true;
        if (err instanceof InternalServerError) return true;
        if (err instanceof APIError) {
            return err.status === 503 || err.status === 529;
        }
        return false;
    }

    private async run(prompt: string): Promise<string> {
        return runWithRetry(() => this.runOnce(prompt), {
            isRetryable: (err) => this.isRetryable(err),
            label: "[Bedrock]",
        });
    }

    private async runOnce(prompt: string): Promise<string> {
        const response = await this.client.messages.create(
            {
                model: this.modelId,
                max_tokens: this.maxTokens,
                messages: [{ role: "user", content: prompt }],
            },
            { timeout: this.timeout },
        );

        const text = response.content
            .filter(
                (block): block is typeof block & { type: "text"; text: string } =>
                    block.type === "text",
            )
            .map((block) => block.text)
            .join("");

        if (!text) {
            throw new Error(
                `Bedrock returned no text content (model=${this.modelId}, stop_reason=${response.stop_reason ?? "null"})`,
            );
        }

        return text.trim();
    }

    async extractStructured(text: string, schema: string, prompt?: string): Promise<unknown[]> {
        const systemPrompt = prompt ?? "Extract structured information from the following text.";

        const fullPrompt = `${systemPrompt}\n\nExpected output schema for each item:\n${schema}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of objects matching the schema.`;
        const response = await this.run(fullPrompt);
        return parseJsonResponse<unknown[]>(response);
    }

    async extract(text: string, prompt?: string): Promise<string[]> {
        const systemPrompt =
            prompt ??
            "Extract the key factual claims from the following text. Return a JSON array of strings, each being one atomic fact.";

        const fullPrompt = `${systemPrompt}\n\n<text>\n${text}\n</text>\n\nReturn ONLY a JSON array of strings.`;
        const response = await this.run(fullPrompt);
        return parseJsonResponse<string[]>(response);
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
        return parseJsonResponse<string[]>(response);
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

export { BedrockAdapter };
