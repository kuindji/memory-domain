/**
 * Phase 7.5 MSC dry-run.
 *
 * Runs the path-memory retriever against an MSC (Multi-Session Chat) JSON
 * dump and scores persona-recall: for each dialogue we ingest all sessions,
 * probe "What do we know about Speaker 1/2?", and score retrieved context
 * against the final-session persona list. Rule-based, no LLM judge. MSC
 * has no built-in QA; numbers are corpus-shape diagnostics, not a
 * leaderboard metric. See `notes/phase-7.5-reading.md`.
 *
 * Usage:
 *   bun scripts/phase-7.5-msc-dryrun.ts [path] [--limit N]
 *
 * Defaults:
 *   path    ./data/msc-test.json  (from HF datasets-server rows endpoint,
 *                                   test split; see reading note)
 *   output  ./data/phase-7.5-msc-dryrun-output.json
 *
 * If the dataset file is missing, this script prints a placement hint
 * and exits 0 (CI-friendly).
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder } from "../src/embedder.js";
import { loadMsc } from "../data/msc-loader.js";
import { runMsc, type MscDialogueResult } from "../eval/msc-adapter.js";
import {
    aggregateMsc,
    scoreMsc,
    type MscAggregate,
    type MscDialogueScore,
} from "../eval/msc-score.js";
import type { RetrievalOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, "../data/msc-test.json");
const DEFAULT_OUT = resolve(here, "../data/phase-7.5-msc-dryrun-output.json");

// Phase 2.14 ship-default config — identical to the LOCOMO dry-run. See
// notes/phase-7.5-reading.md for sourcing of each value.
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
};

function parseArgs(argv: string[]): Args {
    let datasetPath = DEFAULT_PATH;
    let limit: number | undefined;
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
        } else if (!a.startsWith("-")) {
            datasetPath = resolve(a);
        } else {
            throw new Error(`Unknown flag: ${a}`);
        }
    }
    return { datasetPath, limit };
}

function formatMs(ms: number): string {
    return `${ms.toFixed(1)}ms`;
}

function printAggregate(agg: MscAggregate, label: string): void {
    console.log(
        [
            label.padEnd(14),
            String(agg.probeCount).padStart(6),
            agg.meanPersonaTokenRecall.toFixed(3).padStart(7),
            agg.medianPersonaTokenRecall.toFixed(3).padStart(7),
            (agg.fractionAbove80 * 100).toFixed(1).padStart(5) + "%",
            agg.meanPersonaStringContainmentRate.toFixed(3).padStart(7),
        ].join(" | "),
    );
}

function summarize(
    results: MscDialogueResult[],
    scores: MscDialogueScore[],
    totalMs: number,
): void {
    let ingestSum = 0;
    let retrieveSum = 0;
    let claimSum = 0;
    for (const r of results) {
        ingestSum += r.ingestMs;
        retrieveSum += r.speaker1.retrieveMs + r.speaker2.retrieveMs;
        claimSum += r.ingestedClaimCount;
    }
    const n = results.length;
    console.log(
        `# MSC dialogues: ${n}  totalMs=${formatMs(totalMs)}  avgIngestMs=${(ingestSum / Math.max(1, n)).toFixed(1)}  avgRetrieveMs=${(retrieveSum / Math.max(1, n * 2)).toFixed(1)}  avgClaims=${(claimSum / Math.max(1, n)).toFixed(1)}`,
    );
    console.log();
    const aggregates = aggregateMsc(scores);
    console.log("speaker        | probes | mean    | median  | ≥80% | meanCon ");
    console.log("-".repeat(75));
    printAggregate(aggregates.speaker1, "Speaker 1");
    printAggregate(aggregates.speaker2, "Speaker 2");
    printAggregate(aggregates.combined, "combined");
}

function buildOutput(results: MscDialogueResult[], scores: MscDialogueScore[]): unknown {
    const byId = new Map(scores.map((s) => [s.dialogueId, s]));
    return results.map((r) => ({
        dialogueId: r.dialogueId,
        ingestedClaimCount: r.ingestedClaimCount,
        sessionCount: r.sessionCount,
        ingestMs: r.ingestMs,
        speaker1: {
            probeText: r.speaker1.probeText,
            goldPersona: r.speaker1.goldPersona,
            retrievedClaimIds: r.speaker1.retrievedClaimIds,
            retrievedClaimTexts: r.speaker1.retrievedClaimTexts,
            retrieveMs: r.speaker1.retrieveMs,
            metrics: byId.get(r.dialogueId)?.speaker1 ?? null,
        },
        speaker2: {
            probeText: r.speaker2.probeText,
            goldPersona: r.speaker2.goldPersona,
            retrievedClaimIds: r.speaker2.retrievedClaimIds,
            retrievedClaimTexts: r.speaker2.retrievedClaimTexts,
            retrieveMs: r.speaker2.retrieveMs,
            metrics: byId.get(r.dialogueId)?.speaker2 ?? null,
        },
    }));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!existsSync(args.datasetPath)) {
        console.log(`# Phase 7.5 MSC dry-run`);
        console.log(`# Dataset not found at: ${args.datasetPath}`);
        console.log(`#`);
        console.log(`# Download the HF mirror:`);
        console.log(`#   huggingface.co/datasets/nayohan/multi_session_chat`);
        console.log(`# Either convert parquet → JSON locally, or use the HF`);
        console.log(`# datasets-server rows endpoint (see notes/phase-7.5-reading.md).`);
        console.log(`# Exiting without error to keep CI green.`);
        return;
    }

    const dialogues = loadMsc(args.datasetPath);
    const selected = args.limit !== undefined ? dialogues.slice(0, args.limit) : dialogues;

    console.log(`# Phase 7.5 MSC dry-run`);
    console.log(`#   dataset            ${args.datasetPath}`);
    console.log(`#   total dialogues    ${dialogues.length}`);
    if (args.limit !== undefined) console.log(`#   limit              ${args.limit}`);
    console.log(`#   selected dialogues ${selected.length}`);
    console.log();

    if (selected.length === 0) {
        console.log("# No dialogues selected; nothing to do.");
        return;
    }

    const embedder = await getEmbedder();
    const started = performance.now();
    const results = await runMsc(selected, {
        embedder,
        retrievalOptions: RETRIEVAL_OPTIONS,
    });
    const totalMs = performance.now() - started;

    const scores = scoreMsc(results);
    summarize(results, scores, totalMs);

    writeFileSync(DEFAULT_OUT, JSON.stringify(buildOutput(results, scores), null, 2), "utf8");
    console.log();
    console.log(`# wrote ${DEFAULT_OUT}`);
}

await main();
