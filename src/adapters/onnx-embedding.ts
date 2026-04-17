/**
 * ONNX-based local embedding adapter for BERT-family encoders
 * (e.g. all-MiniLM-L6-v2 with mean pooling, BGE-small-en-v1.5 with CLS pooling).
 * Runs entirely offline — no API calls needed.
 */

import * as ort from "onnxruntime-node";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import type { EmbeddingAdapter } from "../core/types.js";
import { WordPieceTokenizer } from "./wordpiece-tokenizer.js";

type PoolingStrategy = "mean" | "cls";

interface OnnxEmbeddingConfig {
    modelDir?: string;
    modelFile?: string;
    vocabFile?: string;
    maxSequenceLength?: number;
    pooling?: PoolingStrategy;
}

const DEFAULT_MODEL_DIR = resolve(process.cwd(), ".memory-domain", "model");
const DEFAULT_MODEL_FILE = "model.onnx";
const DEFAULT_VOCAB_FILE = "vocab.txt";
const DEFAULT_MAX_SEQ_LENGTH = 512;
const DEFAULT_POOLING: PoolingStrategy = "mean";

class OnnxEmbeddingAdapter implements EmbeddingAdapter {
    private session: ort.InferenceSession | null = null;
    private tokenizer: WordPieceTokenizer = new WordPieceTokenizer();
    private modelPath: string;
    private vocabPath: string;
    private maxSeqLength: number;
    private pooling: PoolingStrategy;
    private embeddingDimension: number = 0;

    constructor(config?: OnnxEmbeddingConfig) {
        const dir = config?.modelDir ?? DEFAULT_MODEL_DIR;
        this.modelPath = join(dir, config?.modelFile ?? DEFAULT_MODEL_FILE);
        this.vocabPath = join(dir, config?.vocabFile ?? DEFAULT_VOCAB_FILE);
        this.maxSeqLength = config?.maxSequenceLength ?? DEFAULT_MAX_SEQ_LENGTH;
        this.pooling = config?.pooling ?? DEFAULT_POOLING;
    }

    get dimension(): number {
        return this.embeddingDimension;
    }

    private async ensureLoaded(): Promise<void> {
        if (this.session) return;

        if (!existsSync(this.modelPath)) {
            throw new Error(`ONNX model not found at ${this.modelPath}`);
        }
        if (!existsSync(this.vocabPath)) {
            throw new Error(`Vocabulary file not found at ${this.vocabPath}`);
        }

        await this.tokenizer.load(this.vocabPath);
        this.session = await ort.InferenceSession.create(this.modelPath, {
            executionProviders: ["cpu"],
        });

        // Run a probe to determine embedding dimensions
        const probe = await this.runInference(["hello"]);
        this.embeddingDimension = probe[0].length;
    }

    private async runInference(texts: string[]): Promise<number[][]> {
        if (!this.session) throw new Error("Session not initialized");

        const batchSize = texts.length;
        const allInputIds: number[] = [];
        const allAttentionMasks: number[] = [];

        for (const text of texts) {
            const { inputIds, attentionMask } = this.tokenizer.encode(text, this.maxSeqLength);
            allInputIds.push(...inputIds);
            allAttentionMasks.push(...attentionMask);
        }

        const inputIdsTensor = new ort.Tensor(
            "int64",
            BigInt64Array.from(allInputIds.map((v) => BigInt(v))),
            [batchSize, this.maxSeqLength],
        );
        const attentionMaskTensor = new ort.Tensor(
            "int64",
            BigInt64Array.from(allAttentionMasks.map((v) => BigInt(v))),
            [batchSize, this.maxSeqLength],
        );
        const tokenTypeIdsTensor = new ort.Tensor(
            "int64",
            new BigInt64Array(batchSize * this.maxSeqLength),
            [batchSize, this.maxSeqLength],
        );

        const feeds: Record<string, ort.Tensor> = {
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
            token_type_ids: tokenTypeIdsTensor,
        };

        const output = await this.session.run(feeds);

        const outputName = this.session.outputNames[0];
        if (!outputName) throw new Error("Model has no output names");
        const outputTensor = output[outputName];
        if (!outputTensor) throw new Error(`Output "${outputName}" not found`);

        const data = outputTensor.data as Float32Array;
        const dims = outputTensor.dims;

        const hiddenSize = dims[dims.length - 1];
        const seqLength = dims.length === 3 ? dims[1] : this.maxSeqLength;

        if (this.pooling === "cls" && dims.length !== 3) {
            throw new Error(
                `CLS pooling requires a 3-D last-hidden-state output; got dims [${dims.join(", ")}]`,
            );
        }

        const results: number[][] = [];

        for (let b = 0; b < batchSize; b++) {
            const embedding = new Float32Array(hiddenSize);

            if (this.pooling === "cls") {
                // CLS token is always at position 0 of the sequence dimension.
                const offset = b * seqLength * hiddenSize;
                for (let h = 0; h < hiddenSize; h++) {
                    embedding[h] = data[offset + h] ?? 0;
                }
            } else {
                // Mean pooling over sequence dimension with attention mask.
                let tokenCount = 0;
                for (let s = 0; s < seqLength; s++) {
                    const maskIdx = b * this.maxSeqLength + s;
                    if (allAttentionMasks[maskIdx] === 0) continue;
                    tokenCount++;

                    const offset = b * seqLength * hiddenSize + s * hiddenSize;
                    for (let h = 0; h < hiddenSize; h++) {
                        embedding[h] += data[offset + h] ?? 0;
                    }
                }

                if (tokenCount > 0) {
                    for (let h = 0; h < hiddenSize; h++) {
                        embedding[h] /= tokenCount;
                    }
                }
            }

            // L2 normalize
            let norm = 0;
            for (let h = 0; h < hiddenSize; h++) {
                norm += embedding[h] * embedding[h];
            }
            norm = Math.sqrt(norm);
            if (norm > 0) {
                for (let h = 0; h < hiddenSize; h++) {
                    embedding[h] /= norm;
                }
            }

            results.push(Array.from(embedding));
        }

        return results;
    }

    async embed(text: string): Promise<number[]> {
        await this.ensureLoaded();
        const results = await this.runInference([text]);
        return results[0];
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        await this.ensureLoaded();
        if (texts.length === 0) return [];

        const batchSize = 32;
        const results: number[][] = [];
        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const embeddings = await this.runInference(batch);
            results.push(...embeddings);
        }
        return results;
    }
}

export { OnnxEmbeddingAdapter };
export type { OnnxEmbeddingConfig };
