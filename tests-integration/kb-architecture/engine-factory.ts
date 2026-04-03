// tests-integration/kb-architecture/engine-factory.ts
import { MemoryEngine } from "../../src/core/engine.js";
import { ClaudeCliAdapter } from "../../src/adapters/llm/claude-cli.js";
import { OnnxEmbeddingAdapter } from "../../src/adapters/onnx-embedding.js";
import { topicDomain } from "../../src/domains/topic/index.js";
import { createKbDomain } from "../../src/domains/kb/kb-domain.js";
import type { ArchitectureConfig } from "./types.js";
import { createConfigurableInboxProcessor } from "./configurable-inbox.js";
import type { DomainConfig } from "../../src/core/types.js";

const llm = new ClaudeCliAdapter({ model: "haiku" });
const embedding = new OnnxEmbeddingAdapter();

export function getLlm(): ClaudeCliAdapter {
    return llm;
}

export function getEmbedding(): OnnxEmbeddingAdapter {
    return embedding;
}

/**
 * Creates a MemoryEngine configured for a specific architecture variant.
 * The KB domain's processInboxBatch is replaced with a configurable version.
 */
export async function createConfiguredEngine(config: ArchitectureConfig): Promise<MemoryEngine> {
    const engine = new MemoryEngine();
    await engine.initialize({
        connection: "mem://",
        namespace: "test",
        database: `arch_${config.name}_${Date.now()}`,
        llm,
        embedding,
        search: {
            defaultMode: config.search.mode,
            defaultWeights: config.search.weights,
        },
        debug: { timing: true },
    });

    // Create a modified KB domain with configurable pipeline stages
    const baseDomain = createKbDomain({
        consolidateSchedule: { enabled: false }, // We run consolidation manually in Phase 3
    });

    const configurableProcessor = createConfigurableInboxProcessor(config.pipeline);

    const modifiedDomain: DomainConfig = {
        ...baseDomain,
        processInboxBatch: configurableProcessor,
    };

    await engine.registerDomain(modifiedDomain);
    await engine.registerDomain(topicDomain);

    return engine;
}

export async function drainInbox(engine: MemoryEngine): Promise<void> {
    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }
}
