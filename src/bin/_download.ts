import { createWriteStream, existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { stdout } from "node:process";

export interface HfFile {
    /** File name as it should appear on disk inside the target directory. */
    name: string;
    /** Fully resolved download URL (e.g. huggingface.co/<repo>/resolve/main/<path>). */
    url: string;
}

export function formatMB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Stream a single file to `<dir>/<file.name>` via a `.partial` sidecar, with
 * progress logging to stdout. Overwrites any existing `.partial` but is a
 * no-op (unless `force` is true) if the final target already exists.
 */
export async function downloadFile(file: HfFile, dir: string, force = false): Promise<void> {
    const target = join(dir, file.name);
    if (!force && existsSync(target)) {
        stdout.write(`  ${file.name} already exists, skipping\n`);
        return;
    }

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

/** Resolve the recursive file tree of an HF repo as flat file paths (no directories). */
export async function listHfRepoFiles(repo: string, revision = "main"): Promise<string[]> {
    const out: string[] = [];
    async function walk(path: string): Promise<void> {
        const url = `https://huggingface.co/api/models/${repo}/tree/${revision}${path ? `/${path}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(
                `HF tree listing failed for ${repo}${path ? `/${path}` : ""}: ${res.status} ${res.statusText}`,
            );
        }
        const raw: unknown = await res.json();
        if (!Array.isArray(raw)) {
            throw new Error(
                `HF tree listing for ${repo}${path ? `/${path}` : ""}: unexpected response shape`,
            );
        }
        const entries = raw as Array<{ type: "file" | "directory"; path: string }>;
        for (const entry of entries) {
            if (entry.type === "file") {
                out.push(entry.path);
            } else if (entry.type === "directory") {
                await walk(entry.path);
            }
        }
    }
    await walk("");
    return out;
}

export function hfResolveUrl(repo: string, path: string, revision = "main"): string {
    return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}
