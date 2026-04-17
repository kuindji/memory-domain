#!/usr/bin/env node
/**
 * Downloads a local BERT-family embedding model (ONNX + vocab) from
 * HuggingFace into the directory that `OnnxEmbeddingAdapter` reads.
 *
 * Usage:
 *   memory-domain-download-model [--model <name>] [--dir <path>] [--force]
 *
 * Supported models:
 *   minilm     all-MiniLM-L6-v2           (default, 384d, ~86 MB)
 *   bge-small  BAAI/bge-small-en-v1.5     (384d, ~133 MB, CLS-pooled)
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { argv, cwd, exit, stdout } from "node:process";

interface ModelFile {
    name: string;
    url: string;
}

interface ModelSpec {
    defaultSubdir: string;
    files: ModelFile[];
}

const MODELS: Record<string, ModelSpec> = {
    minilm: {
        defaultSubdir: "model",
        files: [
            {
                name: "model.onnx",
                url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
            },
            {
                name: "vocab.txt",
                url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/vocab.txt",
            },
        ],
    },
    "bge-small": {
        defaultSubdir: "model-bge-small",
        files: [
            {
                name: "model.onnx",
                url: "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx",
            },
            {
                name: "vocab.txt",
                url: "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/vocab.txt",
            },
        ],
    },
};

const DEFAULT_MODEL = "minilm";

interface Options {
    model: string;
    dir: string;
    force: boolean;
}

function printHelp(): void {
    const modelList = Object.entries(MODELS)
        .map(
            ([name, spec]) =>
                `                   ${name.padEnd(10)} → .memory-domain/${spec.defaultSubdir}`,
        )
        .join("\n");
    stdout.write(
        [
            "Usage: memory-domain-download-model [options]",
            "",
            "Downloads a BERT-family ONNX embedding model and vocab into the",
            "directory used by OnnxEmbeddingAdapter.",
            "",
            "Options:",
            `  --model <name> Model to download (default: ${DEFAULT_MODEL})`,
            modelList,
            "  --dir <path>   Override target directory (default: per-model subdir under ./.memory-domain/)",
            "  --force        Re-download even if files already exist",
            "  -h, --help     Show this help",
            "",
        ].join("\n"),
    );
}

function parseOptions(args: string[]): Options {
    let model = DEFAULT_MODEL;
    let explicitDir: string | null = null;
    let force = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
            printHelp();
            exit(0);
        } else if (arg === "--force") {
            force = true;
        } else if (arg === "--model") {
            const next = args[i + 1];
            if (!next) {
                throw new Error("--model requires a name argument");
            }
            if (!(next in MODELS)) {
                const known = Object.keys(MODELS).join(", ");
                throw new Error(`Unknown model "${next}" (known: ${known})`);
            }
            model = next;
            i++;
        } else if (arg === "--dir") {
            const next = args[i + 1];
            if (!next) {
                throw new Error("--dir requires a path argument");
            }
            explicitDir = resolve(cwd(), next);
            i++;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    const subdir = MODELS[model].defaultSubdir;
    const dir = explicitDir ?? resolve(cwd(), ".memory-domain", subdir);
    return { model, dir, force };
}

function formatMB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadFile(file: ModelFile, dir: string): Promise<void> {
    const target = join(dir, file.name);
    const partial = `${target}.partial`;

    const res = await fetch(file.url);
    if (!res.ok || !res.body) {
        throw new Error(`Failed to fetch ${file.url}: ${res.status} ${res.statusText}`);
    }

    const totalHeader = res.headers.get("content-length");
    const total = totalHeader ? Number(totalHeader) : null;

    let downloaded = 0;
    let lastLogged = 0;
    const source = Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>);
    source.on("data", (chunk: Buffer) => {
        downloaded += chunk.length;
        if (total && stdout.isTTY && downloaded - lastLogged > 512 * 1024) {
            lastLogged = downloaded;
            stdout.write(`\r  ${file.name}  ${formatMB(downloaded)} / ${formatMB(total)}`);
        }
    });

    const sink = createWriteStream(partial);

    try {
        await finished(source.pipe(sink));
    } catch (err) {
        await rm(partial, { force: true });
        throw err;
    }

    if (stdout.isTTY && total) {
        stdout.write(`\r  ${file.name}  ${formatMB(downloaded)} / ${formatMB(total)}\n`);
    } else {
        stdout.write(`  ${file.name}  ${formatMB(downloaded)}\n`);
    }

    await rename(partial, target);
}

async function main(): Promise<void> {
    const opts = parseOptions(argv.slice(2));
    const spec = MODELS[opts.model];

    stdout.write(`Downloading ${opts.model} to ${opts.dir}\n`);
    await mkdir(opts.dir, { recursive: true });

    for (const file of spec.files) {
        const target = join(opts.dir, file.name);
        if (!opts.force && existsSync(target)) {
            stdout.write(`  ${file.name} already exists, skipping\n`);
            continue;
        }
        await downloadFile(file, opts.dir);
    }

    stdout.write("\nDone. Files:\n");
    for (const file of spec.files) {
        const info = await stat(join(opts.dir, file.name));
        stdout.write(`  ${file.name}  ${formatMB(info.size)}\n`);
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    exit(1);
});
