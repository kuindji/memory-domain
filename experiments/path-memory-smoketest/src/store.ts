import type { Claim, ClaimId, HistoryEvent, Timestamp } from "./types.js";

export type IngestInput = {
    text: string;
    validFrom: Timestamp;
    supersedes?: ClaimId;
    id?: ClaimId;
};

export type StoreDeps = {
    embed: (text: string) => Promise<number[]>;
    tokenize: (text: string) => string[];
    idGen?: () => ClaimId;
    /**
     * Phase 2.16 — optional secondary encoders. When set, each ingest embeds
     * the text with every named adapter in parallel and attaches the map as
     * `claim.embeddings`. The primary `embed` output still populates
     * `claim.embedding` (unchanged) and is mirrored into `claim.embeddings`
     * under the matching `primaryEncoderName` so downstream code can treat
     * the map as the complete set.
     */
    secondaryEmbedders?: Record<string, { embed: (text: string) => Promise<number[]> }>;
    primaryEncoderName?: string;
};

export type StoreEvent =
    | { kind: "ingested"; claim: Claim }
    | { kind: "superseded"; oldId: ClaimId; newId: ClaimId; at: Timestamp };

export type StoreListener = (event: StoreEvent) => void;

export class MemoryStore {
    private readonly embed: (text: string) => Promise<number[]>;
    private readonly tokenize: (text: string) => string[];
    private readonly idGen: () => ClaimId;
    private readonly secondaryEmbedders?: Record<
        string,
        { embed: (text: string) => Promise<number[]> }
    >;
    private readonly primaryEncoderName?: string;
    private readonly claims = new Map<ClaimId, Claim>();
    private readonly history: HistoryEvent[] = [];
    private readonly listeners = new Set<StoreListener>();
    private counter = 0;

    constructor(deps: StoreDeps) {
        this.embed = deps.embed;
        this.tokenize = deps.tokenize;
        this.idGen = deps.idGen ?? (() => `c${++this.counter}`);
        this.secondaryEmbedders = deps.secondaryEmbedders;
        this.primaryEncoderName = deps.primaryEncoderName;
    }

    async ingest(input: IngestInput): Promise<Claim> {
        const id = input.id ?? this.idGen();
        if (this.claims.has(id)) {
            throw new Error(`Claim id collision: ${id}`);
        }

        if (input.supersedes !== undefined) {
            const old = this.claims.get(input.supersedes);
            if (!old) {
                throw new Error(`Cannot supersede unknown claim: ${input.supersedes}`);
            }
            if (old.validUntil <= input.validFrom) {
                throw new Error(
                    `Claim ${input.supersedes} already invalid at ${old.validUntil}; cannot be superseded at ${input.validFrom}`,
                );
            }
            old.validUntil = input.validFrom;
        }

        const [embedding, tokens, embeddings] = [
            await this.embed(input.text),
            this.tokenize(input.text),
            await this.embedSecondaries(input.text),
        ];
        const allEmbeddings = this.assembleEmbeddings(embedding, embeddings);

        const claim: Claim = {
            id,
            text: input.text,
            embedding,
            embeddings: allEmbeddings,
            tokens,
            validFrom: input.validFrom,
            validUntil: Number.POSITIVE_INFINITY,
            supersedes: input.supersedes,
        };

        this.claims.set(id, claim);
        this.history.push({ kind: "ingest", claim, at: input.validFrom });

        if (input.supersedes !== undefined) {
            this.history.push({
                kind: "supersede",
                oldId: input.supersedes,
                newId: id,
                at: input.validFrom,
            });
            this.emit({
                kind: "superseded",
                oldId: input.supersedes,
                newId: id,
                at: input.validFrom,
            });
        }
        this.emit({ kind: "ingested", claim });

        return claim;
    }

    async ingestMany(inputs: IngestInput[]): Promise<Claim[]> {
        const out: Claim[] = [];
        for (const input of inputs) {
            out.push(await this.ingest(input));
        }
        return out;
    }

    getById(id: ClaimId): Claim | undefined {
        return this.claims.get(id);
    }

    allClaims(): Claim[] {
        return Array.from(this.claims.values());
    }

    currentClaims(): Claim[] {
        return this.allClaims().filter((c) => c.validUntil === Number.POSITIVE_INFINITY);
    }

    claimsAt(at: Timestamp): Claim[] {
        return this.allClaims().filter((c) => c.validFrom <= at && at < c.validUntil);
    }

    get historyLog(): readonly HistoryEvent[] {
        return this.history;
    }

    subscribe(listener: StoreListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: StoreEvent): void {
        for (const l of this.listeners) l(event);
    }

    private async embedSecondaries(text: string): Promise<Record<string, number[]> | undefined> {
        if (!this.secondaryEmbedders) return undefined;
        const names = Object.keys(this.secondaryEmbedders);
        if (names.length === 0) return undefined;
        const vectors = await Promise.all(
            names.map((name) => this.secondaryEmbedders![name].embed(text)),
        );
        const out: Record<string, number[]> = {};
        names.forEach((name, i) => {
            out[name] = vectors[i];
        });
        return out;
    }

    private assembleEmbeddings(
        primary: number[],
        secondaries: Record<string, number[]> | undefined,
    ): Record<string, number[]> | undefined {
        if (!secondaries && !this.primaryEncoderName) return undefined;
        const out: Record<string, number[]> = { ...(secondaries ?? {}) };
        if (this.primaryEncoderName !== undefined) out[this.primaryEncoderName] = primary;
        return Object.keys(out).length > 0 ? out : undefined;
    }
}
