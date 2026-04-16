import type { EmbeddingAdapter } from "../../../src/core/types.js";
import { GraphIndex, type GraphConfig } from "./graph.js";
import { MemoryStore, type IngestInput } from "./store.js";
import { Retriever } from "./retriever.js";
import { tokenize } from "./tokenize.js";
import type { Claim, Probe, RetrievalOptions, ScoredPath } from "./types.js";

export type PathMemoryConfig = {
    embedder: EmbeddingAdapter;
    semanticThreshold?: number;
    similarity?: GraphConfig["similarity"];
};

export class PathMemory {
    readonly store: MemoryStore;
    readonly graph: GraphIndex;
    readonly retriever: Retriever;
    readonly embedder: EmbeddingAdapter;

    constructor(config: PathMemoryConfig) {
        this.embedder = config.embedder;
        this.store = new MemoryStore({
            embed: (t) => config.embedder.embed(t),
            tokenize,
        });
        this.graph = new GraphIndex({
            semanticThreshold: config.semanticThreshold,
            similarity: config.similarity,
        });
        this.store.subscribe((e) => {
            if (e.kind === "ingested") this.graph.addClaim(e.claim);
        });
        this.retriever = new Retriever({
            graph: this.graph,
            similarity: config.similarity,
        });
    }

    async ingest(input: IngestInput): Promise<Claim> {
        return this.store.ingest(input);
    }

    async ingestMany(inputs: IngestInput[]): Promise<Claim[]> {
        return this.store.ingestMany(inputs);
    }

    async queryWithProbes(
        probeSentences: string[],
        options?: RetrievalOptions,
    ): Promise<ScoredPath[]> {
        const probes = await this.embedProbes(probeSentences);
        return this.retriever.retrieve(probes, options);
    }

    async queryNatural(query: string, options?: RetrievalOptions): Promise<ScoredPath[]> {
        const significant = tokenize(query);
        if (significant.length === 0) return [];
        const probes = await this.embedProbes(significant);
        return this.retriever.retrieve(probes, options);
    }

    createSession(): Session {
        return new Session(this);
    }

    private async embedProbes(sentences: string[]): Promise<Probe[]> {
        const out: Probe[] = [];
        for (const text of sentences) {
            out.push({ text, embedding: await this.embedder.embed(text) });
        }
        return out;
    }
}

export class Session {
    private readonly accumulated: Probe[] = [];

    constructor(private readonly memory: PathMemory) {}

    get probeCount(): number {
        return this.accumulated.length;
    }

    async addProbeSentences(sentences: string[]): Promise<void> {
        for (const text of sentences) {
            const embedding = await this.memory.embedder.embed(text);
            this.accumulated.push({ text, embedding });
        }
    }

    async addNaturalQuery(query: string): Promise<void> {
        const tokens = tokenize(query);
        for (const text of tokens) {
            const embedding = await this.memory.embedder.embed(text);
            this.accumulated.push({ text, embedding });
        }
    }

    retrieve(options?: RetrievalOptions): ScoredPath[] {
        return this.memory.retriever.retrieve(this.accumulated, options);
    }

    reset(): void {
        this.accumulated.length = 0;
    }
}
