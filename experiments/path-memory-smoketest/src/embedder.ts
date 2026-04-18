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

async function loadEncoder(name: EncoderName): Promise<EmbeddingAdapter> {
    const existing = cacheByEncoder.get(name);
    if (existing) return existing;
    const modelDir = resolve(here, "../../../.memory-domain", SUBDIRS[name]);
    const onnx = new OnnxEmbeddingAdapter({ modelDir, pooling: "cls" });
    await onnx.embed("warmup");
    const cached = new CachedEmbeddingAdapter(onnx);
    cacheByEncoder.set(name, cached);
    return cached;
}

export async function getEmbedder(): Promise<EmbeddingAdapter> {
    return loadEncoder(resolveEncoder());
}

/**
 * Phase 2.16 — load N encoders concurrently. Returned map is keyed by encoder
 * name. Callers can iterate map entries to embed the same text under each
 * encoder in parallel. Subsequent calls reuse `cacheByEncoder` so repeated
 * invocations are cheap.
 */
export async function getEmbedders(
    names: EncoderName[],
): Promise<Record<EncoderName, EmbeddingAdapter>> {
    const unique = Array.from(new Set(names));
    const loaded = await Promise.all(unique.map((name) => loadEncoder(name)));
    const out = {} as Record<EncoderName, EmbeddingAdapter>;
    unique.forEach((name, i) => {
        out[name] = loaded[i];
    });
    return out;
}
