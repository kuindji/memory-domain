import type {
    LLMAdapter,
    EmbeddingAdapter,
    ScoredMemory,
    AgentRunSpec,
    AgentRunResult,
    AgentRunTurn,
} from "../src/core/types.js";

export class MockLLMAdapter implements LLMAdapter {
    extractResult: string[] = [];
    extractStructuredResult: unknown[] | null = null;
    consolidateResult = "";
    generateResult = "";
    synthesizeResult = "";
    /** If set, runAgent returns this answer immediately without invoking toolExec. */
    agentAnswer = "mock agent answer";
    /** If set, runAgent issues these CLI calls in order before emitting agentAnswer. */
    agentToolCalls: string[][] = [];
    /** Captures every AgentRunSpec passed to runAgent for assertions. */
    lastAgentSpec: AgentRunSpec | null = null;

    extract(): Promise<string[]> {
        return Promise.resolve(this.extractResult);
    }
    extractStructured(): Promise<unknown[]> {
        if (this.extractStructuredResult === null) {
            return Promise.reject(new Error("MockLLMAdapter: extractStructuredResult not set"));
        }
        return Promise.resolve(this.extractStructuredResult);
    }
    consolidate(): Promise<string> {
        return Promise.resolve(this.consolidateResult);
    }
    generate(_prompt: string): Promise<string> {
        return Promise.resolve(this.generateResult);
    }
    synthesize(_query: string, _memories: ScoredMemory[], _tagContext?: string[]): Promise<string> {
        return Promise.resolve(this.synthesizeResult);
    }
    async runAgent(spec: AgentRunSpec): Promise<AgentRunResult> {
        this.lastAgentSpec = spec;
        const turns: AgentRunTurn[] = [];
        for (const args of this.agentToolCalls) {
            const result = await spec.toolExec({ command: "memory-domain", args });
            turns.push({ call: { command: "memory-domain", args }, result });
        }
        return { answer: this.agentAnswer, turns };
    }
}

export class MockEmbeddingAdapter implements EmbeddingAdapter {
    readonly dimension = 4;

    embed(text: string): Promise<number[]> {
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
        }
        const vec = [Math.sin(hash), Math.cos(hash), Math.sin(hash * 2), Math.cos(hash * 2)];
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        return Promise.resolve(vec.map((v) => v / norm));
    }

    embedBatch(texts: string[]): Promise<number[][]> {
        return Promise.all(texts.map((t) => this.embed(t)));
    }
}
