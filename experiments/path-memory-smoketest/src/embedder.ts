import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OnnxEmbeddingAdapter } from "../../../src/adapters/onnx-embedding.js";
import { CachedEmbeddingAdapter } from "../../../src/adapters/cached-embedding.js";
import type { EmbeddingAdapter } from "../../../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(here, "../../../.memory-domain/model-bge-small");

let cached: EmbeddingAdapter | null = null;

export async function getEmbedder(): Promise<EmbeddingAdapter> {
    if (cached) return cached;
    const onnx = new OnnxEmbeddingAdapter({ modelDir: MODEL_DIR, pooling: "cls" });
    await onnx.embed("warmup");
    cached = new CachedEmbeddingAdapter(onnx);
    return cached;
}
