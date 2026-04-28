import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

const SNIPPETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skill-snippets");

const INCLUDE_RE = /^@include\s+(\S+)\s*$/;

async function loadSnippet(name: string): Promise<string> {
    const key = `__snippet__/${name}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const filePath = join(SNIPPETS_DIR, `${name}.md`);
    const content = (await readFile(filePath, "utf-8")).trim();
    cache.set(key, content);
    return content;
}

async function expandIncludes(content: string): Promise<string> {
    const lines = content.split("\n");
    const out: string[] = [];
    for (const line of lines) {
        const m = line.match(INCLUDE_RE);
        if (m) {
            out.push(await loadSnippet(m[1]));
        } else {
            out.push(line);
        }
    }
    return out.join("\n");
}

/**
 * Loads a prompt from a domain's skills/ directory.
 * Lines of the form `@include <snippet-name>` are replaced with the contents
 * of `src/skill-snippets/<snippet-name>.md` (one pass, no recursion).
 * Results are cached — each file is read from disk only once.
 */
async function loadPrompt(baseDir: string, name: string): Promise<string> {
    const key = `${baseDir}/${name}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const filePath = join(baseDir, "skills", `${name}.md`);
    const raw = (await readFile(filePath, "utf-8")).trim();
    const content = await expandIncludes(raw);
    cache.set(key, content);
    return content;
}

export { loadPrompt };
