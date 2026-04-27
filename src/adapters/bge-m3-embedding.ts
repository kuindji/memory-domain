/**
 * BGE-M3 embedding adapter (dense head).
 *
 * bge-m3 is XLM-RoBERTa based with SentencePiece tokenization, so it does not
 * fit OnnxEmbeddingAdapter's WordPiece + token_type_ids assumptions. We use
 * @huggingface/transformers (Transformers.js) which bundles SentencePiece +
 * ONNX inference and handles the tokenizer config from the model repo.
 *
 * Dense output: 1024-dim, L2-normalized.
 *
 * Sparse (lexical_weights) and ColBERT (multi-vector) heads are NOT emitted
 * by the stock Xenova/bge-m3 ONNX export. They require a custom export; tracked
 * as a follow-up.
 */

import type { EmbeddingAdapter } from "../core/types.js";

interface BgeM3Config {
    /**
     * HF model id. Default: `Xenova/bge-m3` (dense-only ONNX export).
     */
    modelId?: string;
    /**
     * Override the local directory Transformers.js caches models to.
     * Maps to `env.cacheDir`. Defaults to the library's default (~/.cache/huggingface).
     */
    cacheDir?: string;
    /**
     * ONNX weight dtype. fp32 is safest; q8 cuts size/latency ~4× with small
     * quality loss. fp16 works on GPUs — not a win on CPU.
     */
    dtype?: "fp32" | "fp16" | "q8" | "q4";
    /**
     * Max sequence length. bge-m3 supports up to 8192; default 512 matches the
     * existing OnnxEmbeddingAdapter profile.
     */
    maxSequenceLength?: number;
    /**
     * Batch size for embedBatch. Larger = less overhead but more peak memory.
     */
    batchSize?: number;
}

type Dtype = NonNullable<BgeM3Config["dtype"]>;

const DEFAULT_MODEL_ID = "Xenova/bge-m3";
const DEFAULT_DTYPE: Dtype = "fp32";
const DEFAULT_MAX_SEQ_LENGTH = 512;
const DEFAULT_BATCH_SIZE = 16;

type FeatureExtractionPipeline = import("@huggingface/transformers").FeatureExtractionPipeline;

class BgeM3EmbeddingAdapter implements EmbeddingAdapter {
    private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
    private embeddingDimension = 0;
    private readonly modelId: string;
    private readonly cacheDir: string | undefined;
    private readonly dtype: Dtype;
    private readonly maxSeqLength: number;
    private readonly batchSize: number;

    constructor(config?: BgeM3Config) {
        this.modelId = config?.modelId ?? DEFAULT_MODEL_ID;
        this.cacheDir = config?.cacheDir;
        this.dtype = config?.dtype ?? DEFAULT_DTYPE;
        this.maxSeqLength = config?.maxSequenceLength ?? DEFAULT_MAX_SEQ_LENGTH;
        this.batchSize = config?.batchSize ?? DEFAULT_BATCH_SIZE;
    }

    get dimension(): number {
        return this.embeddingDimension;
    }

    private async ensureLoaded(): Promise<FeatureExtractionPipeline> {
        if (this.pipelinePromise) return this.pipelinePromise;

        this.pipelinePromise = (async () => {
            const transformers = await import("@huggingface/transformers");
            if (this.cacheDir) {
                transformers.env.cacheDir = this.cacheDir;
            }
            const extractor = await transformers.pipeline("feature-extraction", this.modelId, {
                dtype: this.dtype,
            });

            const probe = await extractor("hello", { pooling: "cls", normalize: true });
            const dims = probe.dims;
            const last = dims[dims.length - 1];
            if (typeof last !== "number" || last <= 0) {
                throw new Error(`Unexpected probe output dims: [${dims.join(", ")}]`);
            }
            this.embeddingDimension = last;
            return extractor;
        })();

        try {
            return await this.pipelinePromise;
        } catch (err) {
            this.pipelinePromise = null;
            throw err;
        }
    }

    async embed(text: string): Promise<number[]> {
        const extractor = await this.ensureLoaded();
        const output = await extractor(text, { pooling: "cls", normalize: true });
        return Array.from(output.data as Float32Array);
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const extractor = await this.ensureLoaded();

        const results: number[][] = [];
        for (let i = 0; i < texts.length; i += this.batchSize) {
            const batch = texts.slice(i, i + this.batchSize);
            const output = await extractor(batch, { pooling: "cls", normalize: true });
            const data = output.data as Float32Array;
            const dim = this.embeddingDimension;
            for (let b = 0; b < batch.length; b++) {
                const vec = new Array<number>(dim);
                const offset = b * dim;
                for (let h = 0; h < dim; h++) {
                    vec[h] = data[offset + h] ?? 0;
                }
                results.push(vec);
            }
        }
        return results;
    }
}

export { BgeM3EmbeddingAdapter };
export type { BgeM3Config };
