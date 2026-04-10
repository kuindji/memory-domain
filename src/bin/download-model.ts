#!/usr/bin/env node
/**
 * Downloads the all-MiniLM-L6-v2 ONNX model and vocab from HuggingFace
 * into the directory that `OnnxEmbeddingAdapter` looks at by default
 * (`./.memory-domain/model/` relative to the current working directory).
 *
 * Usage:
 *   memory-domain-download-model [--dir <path>] [--force]
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { argv, cwd, exit, stdout } from "node:process";

const HF_BASE = "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main";

interface ModelFile {
    name: string;
    url: string;
}

const FILES: ModelFile[] = [
    { name: "model.onnx", url: `${HF_BASE}/onnx/model.onnx` },
    { name: "vocab.txt", url: `${HF_BASE}/vocab.txt` },
];

interface Options {
    dir: string;
    force: boolean;
}

function printHelp(): void {
    stdout.write(
        [
            "Usage: memory-domain-download-model [options]",
            "",
            "Downloads the all-MiniLM-L6-v2 ONNX model (~86MB) and vocab",
            "into the directory used by OnnxEmbeddingAdapter.",
            "",
            "Options:",
            "  --dir <path>   Target directory (default: ./.memory-domain/model)",
            "  --force        Re-download even if files already exist",
            "  -h, --help     Show this help",
            "",
        ].join("\n"),
    );
}

function parseOptions(args: string[]): Options {
    const opts: Options = {
        dir: resolve(cwd(), ".memory-domain", "model"),
        force: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
            printHelp();
            exit(0);
        } else if (arg === "--force") {
            opts.force = true;
        } else if (arg === "--dir") {
            const next = args[i + 1];
            if (!next) {
                throw new Error("--dir requires a path argument");
            }
            opts.dir = resolve(cwd(), next);
            i++;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return opts;
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

    stdout.write(`Downloading model to ${opts.dir}\n`);
    await mkdir(opts.dir, { recursive: true });

    for (const file of FILES) {
        const target = join(opts.dir, file.name);
        if (!opts.force && existsSync(target)) {
            stdout.write(`  ${file.name} already exists, skipping\n`);
            continue;
        }
        await downloadFile(file, opts.dir);
    }

    stdout.write("\nDone. Files:\n");
    for (const file of FILES) {
        const info = await stat(join(opts.dir, file.name));
        stdout.write(`  ${file.name}  ${formatMB(info.size)}\n`);
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    exit(1);
});
