/**
 * Phase 7 LongMemEval dry-run.
 *
 * Runs the path-memory retriever against a local LongMemEval JSON file and
 * writes retrieved-context JSON per question for manual inspection. Prints
 * a per-category summary table.
 *
 * Usage:
 *   bun scripts/phase-7-longmemeval-dryrun.ts [path] [--limit N] [--category NAME]
 *
 * Defaults:
 *   path      ./data/longmemeval-s.json
 *   output    ./data/phase-7-dryrun-output.json
 *
 * If the dataset file is missing, this script prints a placement hint and
 * exits 0 (CI-friendly).
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder } from "../src/embedder.js";
import { loadLongMemEval } from "../data/longmemeval-loader.js";
import { runLongMemEval, type LongMemEvalQuestionResult } from "../eval/longmemeval-adapter.js";
import {
    aggregateByCategory,
    aggregateOverall,
    scoreLongMemEval,
    type LongMemEvalScore,
} from "../eval/longmemeval-score.js";
import type { RetrievalOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, "../data/longmemeval-s.json");
const DEFAULT_OUT = resolve(here, "../data/phase-7-dryrun-output.json");

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

function summarize(results: LongMemEvalQuestionResult[]): void {
    const perCategory = new Map<
        string,
        {
            count: number;
            meanPaths: number;
            meanClaims: number;
            meanIngestMs: number;
            meanRetrieveMs: number;
            emptyPathResults: number;
        }
    >();
    for (const r of results) {
        const bucket = perCategory.get(r.category) ?? {
            count: 0,
            meanPaths: 0,
            meanClaims: 0,
            meanIngestMs: 0,
            meanRetrieveMs: 0,
            emptyPathResults: 0,
        };
        bucket.count += 1;
        bucket.meanPaths += r.topPaths.length;
        bucket.meanClaims += r.retrievedClaimIds.length;
        bucket.meanIngestMs += r.ingestMs;
        bucket.meanRetrieveMs += r.retrieveMs;
        if (r.topPaths.length === 0) bucket.emptyPathResults += 1;
        perCategory.set(r.category, bucket);
    }

    console.log(
        "category                       | n   | avgPaths | avgClaims | ingestMs  | retrieveMs | empty",
    );
    console.log("-".repeat(100));
    const categories = Array.from(perCategory.keys()).sort();
    for (const category of categories) {
        const b = perCategory.get(category);
        if (!b) continue;
        console.log(
            [
                category.slice(0, 30).padEnd(30),
                String(b.count).padStart(3),
                (b.meanPaths / b.count).toFixed(2).padStart(8),
                (b.meanClaims / b.count).toFixed(2).padStart(9),
                formatMs(b.meanIngestMs / b.count).padStart(9),
                formatMs(b.meanRetrieveMs / b.count).padStart(10),
                String(b.emptyPathResults).padStart(5),
            ].join(" | "),
        );
    }
}

const RETRIEVAL_OPTIONS: RetrievalOptions = {
    traversal: "dijkstra",
    temporalHopCost: 0.5,
    probeComposition: "weighted-fusion",
    weightedFusionTau: 0.2,
    anchorTopK: 5,
    resultTopN: 10,
    accessTracking: false,
};

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!existsSync(args.datasetPath)) {
        console.log(`# Phase 7 LongMemEval dry-run`);
        console.log(`# Dataset not found at: ${args.datasetPath}`);
        console.log(`#`);
        console.log(`# Place a LongMemEval JSON file (e.g. LongMemEval-S) at the default`);
        console.log(`# path or pass a custom path as the first positional argument.`);
        console.log(`#   https://github.com/xiaowu0162/LongMemEval for distribution.`);
        console.log(`# See notes/phase-7-reading.md for the expected JSON schema.`);
        console.log(`# Exiting without error to keep CI green.`);
        return;
    }

    const all = loadLongMemEval(args.datasetPath);
    const filtered = args.category ? all.filter((q) => q.category === args.category) : all;
    const selected = args.limit !== undefined ? filtered.slice(0, args.limit) : filtered;

    console.log(`# Phase 7 LongMemEval dry-run`);
    console.log(`#   dataset           ${args.datasetPath}`);
    console.log(`#   total questions   ${all.length}`);
    if (args.category) console.log(`#   category filter   ${args.category}`);
    if (args.limit !== undefined) console.log(`#   limit             ${args.limit}`);
    console.log(`#   selected          ${selected.length}`);
    console.log();

    if (selected.length === 0) {
        console.log("# No questions after filtering; nothing to do.");
        return;
    }

    const embedder = await getEmbedder();
    const started = performance.now();
    const results = await runLongMemEval(selected, {
        embedder,
        retrievalOptions: RETRIEVAL_OPTIONS,
    });
    const totalMs = performance.now() - started;

    summarize(results);
    console.log();
    console.log(
        `# total wall-clock: ${formatMs(totalMs)}  (${(totalMs / selected.length).toFixed(1)}ms / question)`,
    );

    const scores = scoreLongMemEval(results);
    console.log();
    summarizeScores(scores);

    writeFileSync(DEFAULT_OUT, JSON.stringify(buildOutput(results, scores), null, 2), "utf8");
    console.log();
    console.log(`# wrote ${DEFAULT_OUT}`);
}

function summarizeScores(scores: LongMemEvalScore[]): void {
    const overall = aggregateOverall(scores);
    console.log(
        `# rule-based scoring (no LLM judge):  n=${overall.count}  contain=${(overall.substringContainmentRate * 100).toFixed(1)}%  fullCov=${(overall.fullTokenCoverageRate * 100).toFixed(1)}%  meanRecall=${overall.meanTokenRecall.toFixed(3)}  meanF1=${overall.meanTokenF1.toFixed(3)}  unreachable=${overall.unreachableCount}`,
    );
    console.log();
    console.log(
        "category                       | n   | contain | fullCov | recall | F1    | meanRank | unreach",
    );
    console.log("-".repeat(100));
    for (const agg of aggregateByCategory(scores)) {
        console.log(
            [
                agg.category.slice(0, 30).padEnd(30),
                String(agg.count).padStart(3),
                (agg.substringContainmentRate * 100).toFixed(1).padStart(6) + "%",
                (agg.fullTokenCoverageRate * 100).toFixed(1).padStart(6) + "%",
                agg.meanTokenRecall.toFixed(3).padStart(6),
                agg.meanTokenF1.toFixed(3).padStart(5),
                (agg.meanSubstringFirstRank >= 0
                    ? agg.meanSubstringFirstRank.toFixed(2)
                    : "—"
                ).padStart(8),
                String(agg.unreachableCount).padStart(7),
            ].join(" | "),
        );
    }
}

function buildOutput(results: LongMemEvalQuestionResult[], scores: LongMemEvalScore[]): unknown {
    const scoreById = new Map(scores.map((s) => [s.questionId, s]));
    return results.map((r) => {
        const score = scoreById.get(r.questionId);
        return {
            questionId: r.questionId,
            category: r.category,
            questionText: r.questionText,
            goldAnswer: r.goldAnswer,
            ingestedClaimCount: r.ingestedClaimCount,
            retrievedClaimIds: r.retrievedClaimIds,
            retrievedClaimTexts: r.retrievedClaimTexts,
            topPathCount: r.topPaths.length,
            ingestMs: r.ingestMs,
            retrieveMs: r.retrieveMs,
            metrics: score?.metrics ?? null,
        };
    });
}

await main();
