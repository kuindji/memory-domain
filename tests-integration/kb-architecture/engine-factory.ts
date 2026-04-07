// tests-integration/kb-architecture/engine-factory.ts
import { MemoryEngine } from "../../src/core/engine.js";
import { ClaudeCliAdapter } from "../../src/adapters/llm/claude-cli.js";
import { OnnxEmbeddingAdapter } from "../../src/adapters/onnx-embedding.js";
import { topicDomain } from "../../src/domains/topic/index.js";
import { createKbDomain } from "../../src/domains/kb/kb-domain.js";
import type { ArchitectureConfig } from "./types.js";
import { createConfigurableInboxProcessor } from "./configurable-inbox.js";
import type { DomainConfig } from "../../src/core/types.js";

const defaultLlm = new ClaudeCliAdapter({ model: "haiku", timeout: 180_000 });
const embedding = new OnnxEmbeddingAdapter();

export function getLlm(): ClaudeCliAdapter {
    return defaultLlm;
}

export function getEmbedding(): OnnxEmbeddingAdapter {
    return embedding;
}

/**
 * Creates a MemoryEngine configured for a specific architecture variant.
 * The KB domain's processInboxBatch is replaced with a configurable version.
 */
export async function createConfiguredEngine(config: ArchitectureConfig): Promise<MemoryEngine> {
    const llm = config.answerModel
        ? new ClaudeCliAdapter({
              model: config.answerModel,
              modelLevels: { low: "haiku" },
              timeout: 180_000,
          })
        : defaultLlm;

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
    const baseDomain = createKbDomain({ consolidateSchedule: { enabled: false } });

    const configurableProcessor = createConfigurableInboxProcessor(config.pipeline);

    const modifiedDomain: DomainConfig = {
        ...baseDomain,
        processInboxBatch: configurableProcessor,
    };

    // If noise reduction config doesn't include tightenFilters,
    // override tunable params to use old permissive defaults
    if (!config.noiseReduction?.tightenFilters && modifiedDomain.tunableParams) {
        modifiedDomain.tunableParams = modifiedDomain.tunableParams.map((p) => {
            if (p.name === "minScore") return { ...p, default: 0.3 };
            return p;
        });
    }

    await engine.registerDomain(modifiedDomain);
    await engine.registerDomain(topicDomain);

    // Apply noise reduction toggles via tunable params
    if (config.noiseReduction) {
        const overrides: Record<string, number> = {};
        if (config.noiseReduction.embeddingRerank !== undefined) {
            overrides.embeddingRerank = config.noiseReduction.embeddingRerank ? 1 : 0;
        } else {
            // Default: embedding rerank OFF for non-noise-reduction configs
            overrides.embeddingRerank = 0;
        }
        if (config.noiseReduction.llmRerank !== undefined) {
            overrides.llmRerank = config.noiseReduction.llmRerank ? 1 : 0;
        }
        if (config.noiseReduction.useQueryIntent !== undefined) {
            overrides.useQueryIntent = config.noiseReduction.useQueryIntent ? 1 : 0;
        }
        if (config.noiseReduction.mmrLambda !== undefined) {
            overrides.mmrLambda = config.noiseReduction.mmrLambda;
        }
        if (config.noiseReduction.useQuestionSearch !== undefined) {
            overrides.useQuestionSearch = config.noiseReduction.useQuestionSearch ? 1 : 0;
        }
        if (Object.keys(overrides).length > 0) {
            await engine.saveTunableParams("kb", overrides);
        }
    } else {
        // Existing configs without noiseReduction: disable rerank
        await engine.saveTunableParams("kb", { embeddingRerank: 0 });
    }

    return engine;
}

export async function drainInbox(engine: MemoryEngine): Promise<void> {
    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }
}
