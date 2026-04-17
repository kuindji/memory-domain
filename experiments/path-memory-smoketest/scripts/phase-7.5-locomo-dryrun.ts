/**
 * Phase 7.5 LOCOMO dry-run.
 *
 * Runs the path-memory retriever against a local LOCOMO JSON file and
 * writes retrieved-context JSON per question. Prints per-category +
 * overall aggregate tables. LOCOMO's haystack is per-conversation, so
 * we ingest once per conversation and reuse for all QA.
 *
 * Usage:
 *   bun scripts/phase-7.5-locomo-dryrun.ts [path] [--limit N] [--category NAME]
 *
 * Defaults:
 *   path      ./data/locomo.json
 *   output    ./data/phase-7.5-locomo-dryrun-output.json
 *
 * If the dataset file is missing, this script prints a placement hint
 * and exits 0 (CI-friendly).
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder } from "../src/embedder.js";
import { loadLocomo } from "../data/locomo-loader.js";
import {
    runLocomo,
    flattenQuestionResults,
    type LocomoConversationResult,
    type LocomoQuestionResult,
} from "../eval/locomo-adapter.js";
import {
    aggregateLocomoByCategory,
    aggregateLocomoOverall,
    scoreLocomo,
    type LocomoScore,
} from "../eval/locomo-score.js";
import type { RetrievalOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, "../data/locomo.json");
const DEFAULT_OUT = resolve(here, "../data/phase-7.5-locomo-dryrun-output.json");

// Phase 2.14 ship-default config. Hard-coded so it's obvious what's being
// measured; sources documented in notes/phase-7.5-reading.md.
const RETRIEVAL_OPTIONS: RetrievalOptions = {
    traversal: "dijkstra",
    temporalHopCost: 0.5,
    probeComposition: "weighted-fusion",
    weightedFusionTau: 0.2,
    anchorTopK: 5,
    resultTopN: 10,
    sessionDecayTau: 0.2,
    accessTracking: false,
};

type Args = {
    datasetPath: string;
    limit?: number;
    category?: string;
};

function parseArgs(argv: string[]): Args {
    let datasetPath = DEFAULT_PATH;
    let limit: number | undefined;
    let category: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--limit") {
            const next = argv[i + 1];
            if (!next) throw new Error("--limit requires a value");
            const parsed = Number.parseInt(next, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error(`--limit must be a positive integer, got "${next}"`);
            }
            limit = parsed;
            i++;
        } else if (a === "--category") {
            const next = argv[i + 1];
            if (!next) throw new Error("--category requires a value");
            category = next;
            i++;
        } else if (!a.startsWith("-")) {
            datasetPath = resolve(a);
        } else {
            throw new Error(`Unknown flag: ${a}`);
        }
    }
    return { datasetPath, limit, category };
}

function formatMs(ms: number): string {
    return `${ms.toFixed(1)}ms`;
}

function summarizeConversations(results: LocomoConversationResult[]): void {
    console.log(
        "conversation                   | qs  | claims | ingestMs   | avgRetrieveMs | skipped",
    );
    console.log("-".repeat(100));
    for (const r of results) {
        const avgRetrieveMs =
            r.questions.length > 0
                ? r.questions.reduce((acc, q) => acc + q.retrieveMs, 0) / r.questions.length
                : 0;
        console.log(
            [
                r.sampleId.slice(0, 30).padEnd(30),
                String(r.questions.length).padStart(3),
                String(r.ingestedClaimCount).padStart(6),
                formatMs(r.ingestMs).padStart(10),
                formatMs(avgRetrieveMs).padStart(13),
                String(r.skippedTurns).padStart(7),
            ].join(" | "),
        );
    }
}

function summarizeScores(scores: LocomoScore[]): void {
    const overall = aggregateLocomoOverall(scores);
    console.log(
        `# rule-based scoring (no LLM judge):  n=${overall.count} (scored=${overall.scoredCount}, adv=${overall.adversarialCount})  contain=${(overall.substringContainmentRate * 100).toFixed(1)}%  fullCov=${(overall.fullTokenCoverageRate * 100).toFixed(1)}%  meanRecall=${overall.meanTokenRecall.toFixed(3)}  meanF1=${overall.meanTokenF1.toFixed(3)}  evidR=${overall.meanEvidenceRecall.toFixed(3)} (n=${overall.evidenceCount})  unreachable=${overall.unreachableCount}`,
    );
    console.log();
    console.log(
        "category                       | n   | adv | scored | contain | fullCov | recall | F1    | meanRank | evidR  | unreach",
    );
    console.log("-".repeat(130));
    for (const agg of aggregateLocomoByCategory(scores)) {
        console.log(
            [
                agg.category.slice(0, 30).padEnd(30),
                String(agg.count).padStart(3),
                String(agg.adversarialCount).padStart(3),
                String(agg.scoredCount).padStart(6),
                (agg.substringContainmentRate * 100).toFixed(1).padStart(6) + "%",
                (agg.fullTokenCoverageRate * 100).toFixed(1).padStart(6) + "%",
                agg.meanTokenRecall.toFixed(3).padStart(6),
                agg.meanTokenF1.toFixed(3).padStart(5),
                (agg.meanSubstringFirstRank >= 0
                    ? agg.meanSubstringFirstRank.toFixed(2)
                    : "—"
                ).padStart(8),
                agg.meanEvidenceRecall.toFixed(3).padStart(6),
                String(agg.unreachableCount).padStart(7),
            ].join(" | "),
        );
    }
}

function buildOutput(questions: LocomoQuestionResult[], scores: LocomoScore[]): unknown {
    const scoreById = new Map(scores.map((s) => [`${s.sampleId}::${s.questionIndex}`, s]));
    return questions.map((q) => {
        const key = `${q.sampleId}::${q.questionIndex}`;
        const score = scoreById.get(key);
        return {
            sampleId: q.sampleId,
            questionIndex: q.questionIndex,
            category: q.category,
            adversarial: q.adversarial,
            questionText: q.questionText,
            goldAnswer: q.goldAnswer,
            evidenceDiaIds: q.evidenceDiaIds,
            retrievedClaimIds: q.retrievedClaimIds,
            retrievedClaimTexts: q.retrievedClaimTexts,
            retrievedDiaIds: q.retrievedDiaIds,
            topPathCount: q.topPaths.length,
            retrieveMs: q.retrieveMs,
            metrics: score?.metrics ?? null,
        };
    });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!existsSync(args.datasetPath)) {
        console.log(`# Phase 7.5 LOCOMO dry-run`);
        console.log(`# Dataset not found at: ${args.datasetPath}`);
        console.log(`#`);
        console.log(`# Download from https://github.com/snap-research/locomo and place the`);
        console.log(`# JSON at the default path, or pass a custom path as the first arg.`);
        console.log(`# See notes/phase-7.5-reading.md for the expected schema.`);
        console.log(`# Exiting without error to keep CI green.`);
        return;
    }

    const all = loadLocomo(args.datasetPath);
    let selected = all;
    if (args.category !== undefined) {
        selected = all
            .map((conv) => ({
                ...conv,
                qa: conv.qa.filter((q) => q.category === args.category),
            }))
            .filter((conv) => conv.qa.length > 0);
    }
    if (args.limit !== undefined) selected = selected.slice(0, args.limit);

    const totalQuestions = selected.reduce((acc, c) => acc + c.qa.length, 0);

    console.log(`# Phase 7.5 LOCOMO dry-run`);
    console.log(`#   dataset              ${args.datasetPath}`);
    console.log(`#   total conversations  ${all.length}`);
    if (args.category !== undefined) console.log(`#   category filter      ${args.category}`);
    if (args.limit !== undefined) console.log(`#   conversation limit   ${args.limit}`);
    console.log(`#   selected conv.       ${selected.length}`);
    console.log(`#   selected questions   ${totalQuestions}`);
    console.log();

    if (selected.length === 0) {
        console.log("# No conversations after filtering; nothing to do.");
        return;
    }

    const embedder = await getEmbedder();
    const started = performance.now();
    const convResults = await runLocomo(selected, {
        embedder,
        retrievalOptions: RETRIEVAL_OPTIONS,
    });
    const totalMs = performance.now() - started;

    summarizeConversations(convResults);
    console.log();
    const questions = flattenQuestionResults(convResults);
    console.log(
        `# total wall-clock: ${formatMs(totalMs)}  (${(totalMs / Math.max(1, questions.length)).toFixed(1)}ms / question)`,
    );

    const scores = scoreLocomo(questions);
    console.log();
    summarizeScores(scores);

    writeFileSync(DEFAULT_OUT, JSON.stringify(buildOutput(questions, scores), null, 2), "utf8");
    console.log();
    console.log(`# wrote ${DEFAULT_OUT}`);
}

await main();
