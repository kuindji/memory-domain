#!/usr/bin/env node
/**
 * Downloads a Qwen (or similar) GGUF quant file from HuggingFace. GGUF is the
 * llama.cpp / Ollama format. Run the downloaded file with llama.cpp server,
 * Ollama, or LM Studio, then point OpenAiHttpAdapter at its /v1 endpoint.
 *
 * Usage:
 *   memory-domain-download-gguf-model [--model <alias>] [--repo <hf-repo>] [--file <name>] [--dir <path>] [--force]
 */

import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { downloadFile, formatMB, hfResolveUrl, type HfFile } from "./_download.js";

interface GgufModelSpec {
    repo: string;
    filename: string;
    defaultSubdir: string;
}

const MODELS: Record<string, GgufModelSpec> = {
    "qwen2.5-1.5b-gguf-q4": {
        repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        defaultSubdir: "llm-qwen2.5-1.5b-gguf-q4",
    },
    "qwen2.5-3b-gguf-q4": {
        repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
        filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
        defaultSubdir: "llm-qwen2.5-3b-gguf-q4",
    },
    "qwen2.5-7b-gguf-q4": {
        repo: "Qwen/Qwen2.5-7B-Instruct-GGUF",
        filename: "qwen2.5-7b-instruct-q4_k_m.gguf",
        defaultSubdir: "llm-qwen2.5-7b-gguf-q4",
    },
};

const DEFAULT_MODEL = "qwen2.5-3b-gguf-q4";

interface Options {
    alias: string;
    repo: string;
    filename: string;
    dir: string;
    force: boolean;
}

function printHelp(): void {
    const modelList = Object.entries(MODELS)
        .map(
            ([alias, spec]) =>
                `                   ${alias.padEnd(25)} → ${spec.repo}/${spec.filename}`,
        )
        .join("\n");
    stdout.write(
        [
            "Usage: memory-domain-download-gguf-model [options]",
            "",
            "Downloads a GGUF quant file from HuggingFace. GGUF is the llama.cpp /",
            "Ollama format. Run it with llama.cpp server, Ollama, or LM Studio, then",
            "point OpenAiHttpAdapter at the server's /v1 endpoint.",
            "",
            "Options:",
            `  --model <alias>  Known alias to download (default: ${DEFAULT_MODEL})`,
            modelList,
            "  --repo <hf-repo> Override the HF repo (keeps alias as dir name)",
            "  --file <name>    Override the GGUF filename within the repo",
            "  --dir <path>     Override target directory (default: ./.memory-domain/llm-<alias>/)",
            "  --force          Re-download even if the file already exists",
            "  -h, --help       Show this help",
            "",
        ].join("\n"),
    );
}

function parseOptions(args: string[]): Options {
    let alias = DEFAULT_MODEL;
    let repoOverride: string | null = null;
    let fileOverride: string | null = null;
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
            if (!next) throw new Error("--model requires an alias argument");
            if (!(next in MODELS)) {
                const known = Object.keys(MODELS).join(", ");
                throw new Error(
                    `Unknown model alias "${next}" (known: ${known}). Use --repo and --file to download a custom quant.`,
                );
            }
            alias = next;
            i++;
        } else if (arg === "--repo") {
            const next = args[i + 1];
            if (!next) throw new Error("--repo requires a HuggingFace repo argument");
            repoOverride = next;
            i++;
        } else if (arg === "--file") {
            const next = args[i + 1];
            if (!next) throw new Error("--file requires a filename argument");
            fileOverride = next;
            i++;
        } else if (arg === "--dir") {
            const next = args[i + 1];
            if (!next) throw new Error("--dir requires a path argument");
            explicitDir = resolve(cwd(), next);
            i++;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    const spec = MODELS[alias];
    const repo = repoOverride ?? spec.repo;
    const filename = fileOverride ?? spec.filename;
    const dir = explicitDir ?? resolve(cwd(), ".memory-domain", spec.defaultSubdir);
    return { alias, repo, filename, dir, force };
}

async function main(): Promise<void> {
    const opts = parseOptions(argv.slice(2));

    stdout.write(`Downloading ${opts.alias} (${opts.filename}) to ${opts.dir}\n`);
    await mkdir(opts.dir, { recursive: true });

    const file: HfFile = {
        name: opts.filename,
        url: hfResolveUrl(opts.repo, opts.filename),
    };
    await downloadFile(file, opts.dir, opts.force);

    stdout.write("\nDone. File:\n");
    const info = await stat(join(opts.dir, opts.filename));
    stdout.write(`  ${opts.filename}  ${formatMB(info.size)}\n`);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    exit(1);
});
