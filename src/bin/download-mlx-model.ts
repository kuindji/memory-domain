#!/usr/bin/env node
/**
 * Downloads a Qwen (or similar) MLX model directory from HuggingFace into the
 * directory that an OpenAI-compatible local server (LM Studio, `mlx_lm.server`)
 * can load. Does NOT run the model — that's the server's job.
 *
 * Usage:
 *   memory-domain-download-mlx-model [--model <alias>] [--repo <hf-repo>] [--dir <path>] [--force]
 */

import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { downloadFile, formatMB, hfResolveUrl, listHfRepoFiles, type HfFile } from "./_download.js";

interface MlxModelSpec {
    repo: string;
    defaultSubdir: string;
}

const MODELS: Record<string, MlxModelSpec> = {
    "qwen2.5-1.5b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-1.5B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-1.5b-mlx-4bit",
    },
    "qwen2.5-3b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-3B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-3b-mlx-4bit",
    },
    "qwen2.5-7b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-7B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-7b-mlx-4bit",
    },
    "qwen2.5-14b-mlx-4bit": {
        repo: "mlx-community/Qwen2.5-14B-Instruct-4bit",
        defaultSubdir: "llm-qwen2.5-14b-mlx-4bit",
    },
};

const DEFAULT_MODEL = "qwen2.5-3b-mlx-4bit";

interface Options {
    alias: string;
    repo: string;
    dir: string;
    force: boolean;
}

function printHelp(): void {
    const modelList = Object.entries(MODELS)
        .map(([alias, spec]) => `                   ${alias.padEnd(25)} → ${spec.repo}`)
        .join("\n");
    stdout.write(
        [
            "Usage: memory-domain-download-mlx-model [options]",
            "",
            "Downloads an MLX model directory from HuggingFace. MLX is the Apple ML",
            "framework — on Apple Silicon it is typically 20–40% faster than GGUF",
            "at the same quant level. Run the downloaded model with LM Studio or",
            "`mlx_lm.server`, then point OpenAiHttpAdapter at its /v1 endpoint.",
            "",
            "Options:",
            `  --model <alias>  Known alias to download (default: ${DEFAULT_MODEL})`,
            modelList,
            "  --repo <hf-repo> Override the HF repo for an alias (keeps the alias as dir name)",
            "  --dir <path>     Override target directory (default: ./.memory-domain/llm-<alias>/)",
            "  --force          Re-download even if files already exist",
            "  -h, --help       Show this help",
            "",
        ].join("\n"),
    );
}

function parseOptions(args: string[]): Options {
    let alias = DEFAULT_MODEL;
    let repoOverride: string | null = null;
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
                    `Unknown model alias "${next}" (known: ${known}). Use --repo to download a custom repo.`,
                );
            }
            alias = next;
            i++;
        } else if (arg === "--repo") {
            const next = args[i + 1];
            if (!next) throw new Error("--repo requires a HuggingFace repo argument");
            repoOverride = next;
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
    const dir = explicitDir ?? resolve(cwd(), ".memory-domain", spec.defaultSubdir);
    return { alias, repo, dir, force };
}

async function main(): Promise<void> {
    const opts = parseOptions(argv.slice(2));

    stdout.write(`Resolving file list for ${opts.repo}\n`);
    const paths = await listHfRepoFiles(opts.repo);
    if (paths.length === 0) {
        throw new Error(`No files found in HuggingFace repo ${opts.repo}`);
    }

    stdout.write(`Downloading ${opts.alias} (${paths.length} files) to ${opts.dir}\n`);
    await mkdir(opts.dir, { recursive: true });

    for (const path of paths) {
        const file: HfFile = { name: path, url: hfResolveUrl(opts.repo, path) };
        const subdir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (subdir) {
            await mkdir(join(opts.dir, subdir), { recursive: true });
        }
        await downloadFile(file, opts.dir, opts.force);
    }

    stdout.write("\nDone. Files:\n");
    for (const path of paths) {
        const info = await stat(join(opts.dir, path));
        stdout.write(`  ${path}  ${formatMB(info.size)}\n`);
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    exit(1);
});
