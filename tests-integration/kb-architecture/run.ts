import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { configs } from "./configs.js";
import { datasetPath } from "./checkpoint.js";
import { collectData } from "./phases/0-collect.js";
import { runIngest } from "./phases/1-ingest.js";
import { runProcess } from "./phases/2-process.js";
import { runConsolidate } from "./phases/3-consolidate.js";
import { runEvaluate } from "./phases/4-evaluate.js";
import { runScore } from "./phases/5-score.js";
import { runReport } from "./phases/6-report.js";
import { runTune } from "./phases/7-tune.js";
import { runBaseline } from "./phases/baseline.js";
import { runBaselineFullDoc } from "./phases/baseline-full-doc.js";
import type { ArchitectureConfig } from "./types.js";
import { buildOramaIndex, serializeOramaIndex } from "./orama-index.js";
import { createOramaBuildContext } from "./orama-kb-domain.js";
import type { OramaDb } from "./orama-index.js";

const { values } = parseArgs({
    options: {
        config: { type: "string", short: "c" },
        "from-phase": { type: "string", short: "f" },
        "only-phase": { type: "string", short: "o" },
        baseline: { type: "boolean", short: "b" },
        "full-doc": { type: "boolean" },
        score: { type: "string" },
        report: { type: "boolean", short: "r" },
        collect: { type: "boolean" },
        tune: { type: "string", short: "t" },
    },
    strict: false,
});

async function runConfig(config: ArchitectureConfig, fromPhase: number): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Running config: "${config.name}"`);
    console.log(`${"=".repeat(60)}`);

    let oramaIndex: OramaDb | undefined;

    // Phase 1: Ingest (always needed — creates the engine)
    let engine;
    if (fromPhase <= 1) {
        const result = await runIngest(config);
        engine = result.engine;
    }

    // Phase 2: Process
    if (fromPhase <= 2) {
        if (!engine) {
            const result = await runIngest(config);
            engine = result.engine;
        }
        const processed = await runProcess(config, engine);

        // Fail-fast: classification check
        const factCount = processed.entries.filter(
            (e) => e.assignedClassification === "fact",
        ).length;
        const total = processed.entries.filter(
            (e) => e.assignedClassification !== "unknown",
        ).length;
        if (total > 0 && factCount / total > 0.85 && config.pipeline.classify) {
            console.error(`[FAIL-FAST] >85% classified as "fact" for "${config.name}" — stopping`);
            await engine.close();
            return;
        }

        // Build Orama index after processing (before consolidation)
        if (config.useOrama) {
            console.log(`\n[Phase 2.5: Build Orama Index] Config: "${config.name}"`);
            oramaIndex = await buildOramaIndex(engine);
            await serializeOramaIndex(oramaIndex, config.name);
        }
    }

    // Phase 3: Consolidate
    if (fromPhase <= 3 && engine) {
        await runConsolidate(config, engine);
    }

    // For Orama configs: the index must be built from fully-processed data.
    // If we skipped Phase 2, we can't build a valid index.
    if (config.useOrama && !oramaIndex) {
        console.error(
            `[ERROR] Orama config "${config.name}" requires Phase 1+2 to build index. Re-run without --from-phase.`,
        );
        if (engine) await engine.close();
        return;
    }

    // Phase 4: Evaluate
    if (fromPhase <= 4) {
        if (config.useOrama && oramaIndex && engine) {
            // Patch the existing engine's KB domain to use Orama buildContext.
            // This keeps the same engine with all processed data and matching IDs.
            const kbDomain = engine.getDomainRegistry().get("kb");
            if (kbDomain) {
                kbDomain.buildContext = createOramaBuildContext(oramaIndex);
            }
        }
        if (engine) {
            await runEvaluate(config, engine);
        }
    }

    // Close engine before scoring
    if (engine) {
        await engine.close();
    }

    // Phase 5: Score
    if (fromPhase <= 5) {
        await runScore(config);
    }
}

async function main(): Promise<void> {
    const fromPhase = values["from-phase"] ? parseInt(values["from-phase"] as string, 10) : 0;
    const onlyPhase = values["only-phase"] ? parseInt(values["only-phase"] as string, 10) : null;

    // Phase 0: Collect
    if (values.collect || (!existsSync(datasetPath()) && fromPhase <= 0 && onlyPhase === null)) {
        await collectData();
        if (values.collect) return;
    }

    // Tune
    if (values.tune) {
        const tuneConfig = configs.find((c) => c.name === values.tune);
        if (!tuneConfig) {
            console.error(
                `Config "${values.tune}" not found. Available: ${configs.map((c) => c.name).join(", ")}`,
            );
            process.exit(1);
        }
        await runTune(tuneConfig);
        return;
    }

    // Full-doc baseline — entire dataset as context, Sonnet answers
    if (values["full-doc"]) {
        await runBaselineFullDoc("sonnet");
        await runScore({
            name: "baseline-full-doc-sonnet",
            pipeline: {
                classify: false,
                tagAssign: false,
                topicLink: false,
                supersede: false,
                relateKnowledge: false,
            },
            search: {
                mode: "hybrid",
                weights: { vector: 0.5, fulltext: 0.3, graph: 0.2 },
            },
            consolidate: false,
            contextBudget: 100000,
        });
        return;
    }

    // Score-only for a specific config name
    if (values.score) {
        await runScore({
            name: values.score as string,
            pipeline: {
                classify: false,
                tagAssign: false,
                topicLink: false,
                supersede: false,
                relateKnowledge: false,
            },
            search: {
                mode: "hybrid",
                weights: { vector: 0.5, fulltext: 0.3, graph: 0.2 },
            },
            consolidate: false,
            contextBudget: 2000,
        });
        return;
    }

    // Baseline
    if (values.baseline) {
        await runBaseline();
        await runScore({
            name: "baseline-no-kb",
            pipeline: {
                classify: false,
                tagAssign: false,
                topicLink: false,
                supersede: false,
                relateKnowledge: false,
            },
            search: {
                mode: "hybrid",
                weights: { vector: 0.5, fulltext: 0.3, graph: 0.2 },
            },
            consolidate: false,
            contextBudget: 2000,
        });
        return;
    }

    // Report only
    if (values.report) {
        runReport();
        return;
    }

    // Run specific config or all
    const targetConfigs = values.config
        ? configs.filter((c) => c.name === values.config)
        : configs.filter((c) => c.name !== "baseline-no-kb");

    if (targetConfigs.length === 0) {
        console.error(
            `Config "${values.config}" not found. Available: ${configs.map((c) => c.name).join(", ")}`,
        );
        process.exit(1);
    }

    for (const config of targetConfigs) {
        await runConfig(config, onlyPhase ?? fromPhase);
    }

    // Generate report if we ran multiple configs
    if (targetConfigs.length > 1) {
        runReport();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
