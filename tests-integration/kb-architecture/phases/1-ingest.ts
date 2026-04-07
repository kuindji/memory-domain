import type { ArchitectureConfig, Dataset, IngestedData } from "../types.js";
import { readDataset, writeCheckpoint } from "../checkpoint.js";
import { createConfiguredEngine } from "../engine-factory.js";
import { KB_DOMAIN_ID } from "../../../src/domains/kb/types.js";
import type { MemoryEngine } from "../../../src/core/engine.js";

export async function runIngest(
    config: ArchitectureConfig,
): Promise<{ engine: MemoryEngine; data: IngestedData }> {
    const dataset = readDataset<Dataset>();
    const start = performance.now();

    console.log(`\n[Phase 1: Ingest] Config: "${config.name}", entries: ${dataset.entries.length}`);

    const engine = await createConfiguredEngine(config);
    const memoryIdMap: Record<string, string> = {};

    for (const entry of dataset.entries) {
        const metadata: Record<string, unknown> = {
            datasetId: entry.id,
        };
        if (entry.presetClassification) {
            metadata.classification = entry.presetClassification;
        }

        const result = await engine.ingest(entry.content, {
            domains: [KB_DOMAIN_ID],
            metadata,
        });

        if (result.id) {
            memoryIdMap[entry.id] = result.id;
        }
    }

    const durationMs = performance.now() - start;
    const data: IngestedData = {
        memoryIdMap,
        entryCount: Object.keys(memoryIdMap).length,
    };

    writeCheckpoint(config.name, 1, data, durationMs);
    console.log(
        `[Phase 1] Ingested ${data.entryCount} entries in ${(durationMs / 1000).toFixed(1)}s`,
    );

    return { engine, data };
}

if (import.meta.main) {
    const configName = process.argv[2];
    if (!configName) {
        console.error("Usage: bun run phases/1-ingest.ts <config-name>");
        process.exit(1);
    }
    const { configs } = await import("../configs.js");
    const config = configs.find((c) => c.name === configName);
    if (!config) {
        console.error(`Config "${configName}" not found`);
        process.exit(1);
    }
    const { engine } = await runIngest(config);
    await engine.close();
}
