/**
 * "Whole document" baseline: gives the LLM the entire dataset content
 * as context for each question, then scores the answers.
 * Establishes the ceiling — what score is achievable with perfect retrieval.
 */

import type { Dataset, EvaluationData, EvaluationEntry } from "../types.js";
import { readDataset, writeCheckpoint } from "../checkpoint.js";
import { ClaudeCliAdapter } from "../../../src/adapters/llm/claude-cli.js";

const CONFIG_NAME = "baseline-full-doc";

function buildFullContext(dataset: Dataset): string {
    return dataset.entries.map((e) => e.content).join("\n\n");
}

export async function runBaselineFullDoc(model: string = "sonnet"): Promise<void> {
    const dataset = readDataset<Dataset>();
    const fullContext = buildFullContext(dataset);
    const llm = new ClaudeCliAdapter({ model, timeout: 180_000 });
    const configName = model === "sonnet" ? `${CONFIG_NAME}-sonnet` : CONFIG_NAME;
    const start = performance.now();

    console.log(
        `\n[Baseline Full Doc] Testing ${model} with entire dataset (${dataset.entries.length} entries, ${fullContext.length} chars) on ${dataset.questions.length} questions...\n`,
    );

    const entries: EvaluationEntry[] = [];

    for (const question of dataset.questions) {
        const prompt = `You have the following knowledge base. Answer the question using ONLY information from this knowledge base. Do not add information that is not present here.

<knowledge-base>
${fullContext}
</knowledge-base>

Question: ${question.question}

Answer comprehensively based on the knowledge base above.`;

        const askStart = performance.now();
        const answer = await llm.generate(prompt);
        const askMs = performance.now() - askStart;

        entries.push({
            questionId: question.id,
            question: question.question,
            expectedAnswer: question.expectedAnswer,
            difficulty: question.difficulty,
            context: fullContext,
            answer,
            memoriesReturned: dataset.entries.map((e) => e.id),
            requiredEntryIds: question.requiredEntryIds,
            excludedEntryIds: question.excludedEntryIds,
            buildContextMs: 0,
            askMs,
        });

        console.log(`  [${question.id}] ${(askMs / 1000).toFixed(1)}s`);
    }

    const durationMs = performance.now() - start;
    const avgAskMs = entries.reduce((s, e) => s + e.askMs, 0) / entries.length;

    const data: EvaluationData = { entries, avgBuildContextMs: 0, avgAskMs };

    writeCheckpoint(configName, 4, data, durationMs);
    // Write stub checkpoints so scoring phase can find them
    writeCheckpoint(
        configName,
        1,
        {
            memoryIdMap: Object.fromEntries(dataset.entries.map((e) => [e.id, e.id])),
            entryCount: dataset.entries.length,
        },
        0,
    );
    writeCheckpoint(configName, 2, { entries: [], stageTiming: {}, classificationAccuracy: 1 }, 0);

    console.log(
        `\n[Baseline Full Doc] Done in ${(durationMs / 1000).toFixed(1)}s, avg ask: ${(avgAskMs / 1000).toFixed(1)}s`,
    );
    console.log(
        `Now run scoring: bun run tests-integration/kb-architecture/run.ts --score ${configName}`,
    );
}

if (import.meta.main) {
    const model = process.argv.includes("--haiku") ? "haiku" : "sonnet";
    runBaselineFullDoc(model).catch(console.error);
}
