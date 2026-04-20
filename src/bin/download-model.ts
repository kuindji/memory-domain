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
 *   bge-base   BAAI/bge-base-en-v1.5      (768d, ~436 MB, CLS-pooled)
 *   bge-large  BAAI/bge-large-en-v1.5     (1024d, ~1.3 GB, CLS-pooled)
 */

import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { downloadFile, formatMB, type HfFile } from "./_download.js";

interface ModelSpec {
    defaultSubdir: string;
    files: HfFile[];
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
    "bge-base": {
        defaultSubdir: "model-bge-base",
        files: [
            {
                name: "model.onnx",
                url: "https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/onnx/model.onnx",
            },
            {
                name: "vocab.txt",
                url: "https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/vocab.txt",
            },
        ],
    },
    "bge-large": {
        defaultSubdir: "model-bge-large",
        files: [
            {
                name: "model.onnx",
                url: "https://huggingface.co/BAAI/bge-large-en-v1.5/resolve/main/onnx/model.onnx",
            },
            {
                name: "vocab.txt",
                url: "https://huggingface.co/BAAI/bge-large-en-v1.5/resolve/main/vocab.txt",
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

async function main(): Promise<void> {
    const opts = parseOptions(argv.slice(2));
    const spec = MODELS[opts.model];

    stdout.write(`Downloading ${opts.model} to ${opts.dir}\n`);
    await mkdir(opts.dir, { recursive: true });

    for (const file of spec.files) {
        await downloadFile(file, opts.dir, opts.force);
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
