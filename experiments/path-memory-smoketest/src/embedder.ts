import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OnnxEmbeddingAdapter } from "../../../src/adapters/onnx-embedding.js";
import { CachedEmbeddingAdapter } from "../../../src/adapters/cached-embedding.js";
import type { EmbeddingAdapter } from "../../../src/core/types.js";

export type EncoderName = "bge-small" | "bge-base" | "bge-large";

export const ENCODER_DIMS: Record<EncoderName, number> = {
    "bge-small": 384,
    "bge-base": 768,
    "bge-large": 1024,
};

const here = dirname(fileURLToPath(import.meta.url));

const SUBDIRS: Record<EncoderName, string> = {
    "bge-small": "model-bge-small",
    "bge-base": "model-bge-base",
    "bge-large": "model-bge-large",
};

export function resolveEncoder(): EncoderName {
    const raw = (process.env.ENCODER ?? "bge-base").toLowerCase();
    if (raw === "bge-small" || raw === "bge-base" || raw === "bge-large") return raw;
    throw new Error(`Unknown ENCODER "${raw}" (expected one of: bge-small, bge-base, bge-large)`);
}

const cacheByEncoder = new Map<EncoderName, EmbeddingAdapter>();

export async function getEmbedder(): Promise<EmbeddingAdapter> {
    const encoder = resolveEncoder();
    const existing = cacheByEncoder.get(encoder);
    if (existing) return existing;
    const modelDir = resolve(here, "../../../.memory-domain", SUBDIRS[encoder]);
    const onnx = new OnnxEmbeddingAdapter({ modelDir, pooling: "cls" });
    await onnx.embed("warmup");
    const cached = new CachedEmbeddingAdapter(onnx);
    cacheByEncoder.set(encoder, cached);
    return cached;
}
