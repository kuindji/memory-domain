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
    lexicalIdfFloor?: number;
    temporalDecayTau?: number;
    /**
     * Phase 2.16 — secondary encoders keyed by name. When set, `ingest` and
     * `embedProbes` additionally embed with each secondary and populate the
     * per-encoder `embeddings` map on Claims and Probes. `primaryEncoderName`
     * is the stable key for the primary `embedder`; if set, its vector also
     * lands in `embeddings[primaryEncoderName]` so downstream multi-encoder
     * consumers can treat the map as the full encoder set.
     */
    secondaryEmbedders?: Record<string, EmbeddingAdapter>;
    primaryEncoderName?: string;
};

export class PathMemory {
    readonly store: MemoryStore;
    readonly graph: GraphIndex;
    readonly retriever: Retriever;
    readonly embedder: EmbeddingAdapter;
    readonly secondaryEmbedders?: Record<string, EmbeddingAdapter>;
    readonly primaryEncoderName?: string;

    constructor(config: PathMemoryConfig) {
        this.embedder = config.embedder;
        this.secondaryEmbedders = config.secondaryEmbedders;
        this.primaryEncoderName = config.primaryEncoderName;
        this.store = new MemoryStore({
            embed: (t) => config.embedder.embed(t),
            tokenize,
            secondaryEmbedders: config.secondaryEmbedders,
            primaryEncoderName: config.primaryEncoderName,
        });
        this.graph = new GraphIndex({
            semanticThreshold: config.semanticThreshold,
            similarity: config.similarity,
            lexicalIdfFloor: config.lexicalIdfFloor,
            temporalDecayTau: config.temporalDecayTau,
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
            const embedding = await this.embedder.embed(text);
            const embeddings = await this.embedSecondaryProbe(text, embedding);
            out.push(embeddings ? { text, embedding, embeddings } : { text, embedding });
        }
        return out;
    }

    async embedSecondaryProbe(
        text: string,
        primary: number[],
    ): Promise<Record<string, number[]> | undefined> {
        const hasSecondaries =
            this.secondaryEmbedders !== undefined &&
            Object.keys(this.secondaryEmbedders).length > 0;
        if (!hasSecondaries && this.primaryEncoderName === undefined) return undefined;

        const out: Record<string, number[]> = {};
        const secondaries = this.secondaryEmbedders;
        if (hasSecondaries && secondaries) {
            const names = Object.keys(secondaries);
            const vectors = await Promise.all(names.map((name) => secondaries[name].embed(text)));
            names.forEach((name, i) => {
                out[name] = vectors[i];
            });
        }
        if (this.primaryEncoderName !== undefined) out[this.primaryEncoderName] = primary;
        return Object.keys(out).length > 0 ? out : undefined;
    }
}

export class Session {
    private readonly accumulated: Probe[] = [];
    private currentTurn = 0;

    constructor(private readonly memory: PathMemory) {}

    get probeCount(): number {
        return this.accumulated.length;
    }

    get turnCount(): number {
        return this.currentTurn;
    }

    async addProbeSentences(sentences: string[]): Promise<void> {
        const turnIndex = this.currentTurn++;
        for (const text of sentences) {
            const embedding = await this.memory.embedder.embed(text);
            const embeddings = await this.memory.embedSecondaryProbe(text, embedding);
            this.accumulated.push(
                embeddings
                    ? { text, embedding, embeddings, turnIndex }
                    : { text, embedding, turnIndex },
            );
        }
    }

    async addNaturalQuery(query: string): Promise<void> {
        const turnIndex = this.currentTurn++;
        const tokens = tokenize(query);
        for (const text of tokens) {
            const embedding = await this.memory.embedder.embed(text);
            const embeddings = await this.memory.embedSecondaryProbe(text, embedding);
            this.accumulated.push(
                embeddings
                    ? { text, embedding, embeddings, turnIndex }
                    : { text, embedding, turnIndex },
            );
        }
    }

    retrieve(options?: RetrievalOptions): ScoredPath[] {
        return this.memory.retriever.retrieve(this.accumulated, options);
    }

    reset(): void {
        this.accumulated.length = 0;
        this.currentTurn = 0;
    }
}
