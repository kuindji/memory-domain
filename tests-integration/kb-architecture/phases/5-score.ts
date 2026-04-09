import type {
    ArchitectureConfig,
    EvaluationData,
    ScoresData,
    ScoreEntry,
    ProcessedData,
} from "../types.js";
import { readCheckpoint, writeCheckpoint } from "../checkpoint.js";
import { getLlm } from "../engine-factory.js";
import { ClaudeCliAdapter } from "../../../src/adapters/llm/claude-cli.js";

async function scoreAnswer(
    question: string,
    expectedAnswer: string,
    actualAnswer: string,
    scorerModel?: string,
): Promise<{ score: number; reasoning: string }> {
    const llm = scorerModel
        ? new ClaudeCliAdapter({ model: scorerModel, timeout: 300_000 })
        : getLlm();

    const prompt = `You are a strict grader. Score the following answer on a 0-5 scale.

Question: ${question}

Expected answer (ground truth): ${expectedAnswer}

Actual answer to grade: ${actualAnswer}

Scoring rubric:
0 = completely wrong or hallucinated
1 = vaguely related but incorrect specifics
2 = partially correct, missing key details
3 = mostly correct but has factual errors or wrong sequencing
4 = correct, covers all key points from expected answer
5 = correct, covers all key points from expected answer, no factual errors

Important:
- Adding extra correct detail beyond the expected answer is fine and should NOT reduce the score.
- Treat synonyms and equivalent terminology as correct (e.g., "rejected" and "returned" are interchangeable).
- Expressing the same value in different but mathematically equivalent forms is NOT an error (e.g., "20%" and "£10" when 10 is 20% of 50).
- Focus on whether the actual answer contains all key facts from the expected answer and has no factual errors.
- Wrong sequencing of steps or processes counts as a factual error.
- A "factual error" means stating something that contradicts the expected answer or is objectively false. Rephrasing, reordering non-sequential information, or adding correct context is NOT a factual error.

Respond with ONLY a JSON object: {"score": <0-5>, "reasoning": "<one sentence>"}`;

    try {
        const response = await llm.generate(prompt);
        const match = response.match(/\{[\s\S]*\}/);
        if (match) {
            const parsed = JSON.parse(match[0]) as { score: number; reasoning: string };
            return {
                score: Math.max(0, Math.min(5, Math.round(parsed.score))),
                reasoning: parsed.reasoning ?? "",
            };
        }
    } catch {
        // Fall through
    }

    return { score: 0, reasoning: "Failed to parse scoring response" };
}

export async function runScore(config: ArchitectureConfig): Promise<ScoresData> {
    const evaluation = readCheckpoint<EvaluationData>(config.name, 4);
    const processed = readCheckpoint<ProcessedData>(config.name, 2);
    const start = performance.now();

    console.log(
        `\n[Phase 5: Score] Config: "${config.name}", questions: ${evaluation.data.entries.length}`,
    );

    const scoreEntries: ScoreEntry[] = [];

    for (const evalEntry of evaluation.data.entries) {
        const { score, reasoning } = await scoreAnswer(
            evalEntry.question,
            evalEntry.expectedAnswer,
            evalEntry.answer,
            config.scorerModel,
        );

        const requiredFound = evalEntry.requiredEntryIds.filter((id) =>
            evalEntry.memoriesReturned.includes(id),
        ).length;
        const contextRelevance =
            evalEntry.requiredEntryIds.length > 0
                ? requiredFound / evalEntry.requiredEntryIds.length
                : 1;

        const unrequired = evalEntry.memoriesReturned.filter(
            (id) => !evalEntry.requiredEntryIds.includes(id),
        ).length;
        const contextNoise =
            evalEntry.memoriesReturned.length > 0
                ? unrequired / evalEntry.memoriesReturned.length
                : 0;

        const excludedPresent = evalEntry.excludedEntryIds.filter((id) =>
            evalEntry.memoriesReturned.includes(id),
        ).length;
        const supersessionCorrect =
            evalEntry.excludedEntryIds.length > 0 ? excludedPresent === 0 : true;

        scoreEntries.push({
            questionId: evalEntry.questionId,
            score,
            reasoning,
            contextRelevance,
            contextNoise,
            supersessionCorrect,
        });

        console.log(`  [${evalEntry.questionId}] Score: ${score}/5 — ${reasoning}`);
    }

    const durationMs = performance.now() - start;

    const avgScore = scoreEntries.reduce((s, e) => s + e.score, 0) / scoreEntries.length;
    const avgTime = (evaluation.data.avgBuildContextMs + evaluation.data.avgAskMs) / 1000;
    const qualityPerSecond = avgTime > 0 ? avgScore / avgTime : 0;
    const contextRelevance =
        scoreEntries.reduce((s, e) => s + e.contextRelevance, 0) / scoreEntries.length;
    const contextNoise = scoreEntries.reduce((s, e) => s + e.contextNoise, 0) / scoreEntries.length;
    const supersessionCorrectCount = scoreEntries.filter((e) => e.supersessionCorrect).length;
    const supersessionAccuracy = supersessionCorrectCount / scoreEntries.length;

    const data: ScoresData = {
        entries: scoreEntries,
        avgScore,
        avgTime,
        qualityPerSecond,
        contextRelevance,
        contextNoise,
        supersessionAccuracy,
        classificationAccuracy: processed.data.classificationAccuracy,
    };

    writeCheckpoint(config.name, 5, data, durationMs);

    console.log(`\n[Phase 5 Summary]`);
    console.log(`  Avg Score: ${avgScore.toFixed(2)}/5`);
    console.log(`  Avg Time: ${avgTime.toFixed(1)}s`);
    console.log(`  Quality/s: ${qualityPerSecond.toFixed(3)}`);
    console.log(`  Context Relevance: ${(contextRelevance * 100).toFixed(1)}%`);
    console.log(`  Context Noise: ${(contextNoise * 100).toFixed(1)}%`);
    console.log(`  Supersession Accuracy: ${(supersessionAccuracy * 100).toFixed(1)}%`);
    console.log(
        `  Classification Accuracy: ${(processed.data.classificationAccuracy * 100).toFixed(1)}%`,
    );

    return data;
}
