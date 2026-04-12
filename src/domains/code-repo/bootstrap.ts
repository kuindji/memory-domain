import { readdir, stat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, relative } from "node:path";
import type { DomainContext } from "../../core/types.js";
import { CODE_REPO_TAG, CODE_REPO_TECHNICAL_TAG, CODE_REPO_OBSERVATION_TAG } from "./types.js";
import type { CodeRepoDomainOptions, DirEntry, TriageResult, AnalysisResult } from "./types.js";
import { ensureTag, findOrCreateEntity } from "./utils.js";
import {
    formatTree,
    countDirectories,
    calculateScanDepth,
    validateAnalysisResult,
} from "./bootstrap-utils.js";

const META_LAST_COMMIT = "code-repo:lastCommitHash";

const KEY_FILES = new Set([
    "package.json",
    "tsconfig.json",
    "bun.lockb",
    "bunfig.toml",
    "Cargo.toml",
    "go.mod",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "pyproject.toml",
    "requirements.txt",
    "Gemfile",
    "README.md",
    "readme.md",
]);

const IGNORE_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    "vendor",
]);

/** Maximum total characters of file content to include in prompts. */
const MAX_FILE_CONTENT_CHARS = 60_000;

/** Maximum lines per individual file read. */
const MAX_LINES_PER_FILE = 150;

async function scanDirectory(
    root: string,
    base: string,
    depth: number,
    maxDepth: number,
): Promise<DirEntry[]> {
    if (depth >= maxDepth) return [];

    let entries;
    try {
        entries = await readdir(root);
    } catch {
        return [];
    }

    const result: DirEntry[] = [];

    for (const name of entries) {
        if (name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(name)) continue;

        const fullPath = join(root, name);
        const relPath = relative(base, fullPath);
        let stats;
        try {
            stats = await stat(fullPath);
        } catch {
            continue;
        }

        if (stats.isDirectory()) {
            const children = await scanDirectory(fullPath, base, depth + 1, maxDepth);
            const files: string[] = [];

            for (const child of children) {
                if (!child.isDirectory) {
                    files.push(child.name);
                }
            }

            result.push({
                name,
                relativePath: relPath,
                isDirectory: true,
                children: children.filter((c) => c.isDirectory),
                files,
            });
        } else {
            result.push({ name, relativePath: relPath, isDirectory: false });
        }
    }

    return result;
}

async function readFileContent(
    root: string,
    relativePath: string,
    maxLines: number,
): Promise<string | null> {
    try {
        const content = await readFile(join(root, relativePath), "utf-8");
        return content.split("\n").slice(0, maxLines).join("\n");
    } catch {
        return null;
    }
}

function execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}\n${stderr}`));
            else resolve(stdout);
        });
    });
}

function parseJsonResponse<T>(text: string): T {
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;
    return JSON.parse(jsonStr) as T;
}

export async function bootstrapCodeRepo(
    context: DomainContext,
    options?: CodeRepoDomainOptions,
): Promise<void> {
    const projectRoot = options?.projectRoot;
    if (!projectRoot) return;

    // Step 1: Scan directory structure
    const tree = await scanDirectory(projectRoot, projectRoot, 0, 6);
    const dirCount = countDirectories(tree);
    const displayDepth = calculateScanDepth(dirCount);
    const treeText = formatTree(tree, "", 0, displayDepth);

    const llm = context.llmAt("medium");
    if (!llm.generate) return;

    // Step 2: Triage — let LLM assess repo size and pick files to read
    const triagePrompt = await context.loadPrompt("bootstrap-triage");
    let filesToRead: string[] = [];
    try {
        const triageResponse = await llm.generate(
            `${triagePrompt}\n\nDirectory structure:\n${treeText}\n\nTotal directories: ${dirCount}`,
        );
        const triage = parseJsonResponse<TriageResult>(triageResponse);
        filesToRead = triage.filesToRead ?? [];
    } catch {
        // Triage failed — fall back to root key files only
        for (const entry of tree) {
            if (!entry.isDirectory && KEY_FILES.has(entry.name)) {
                filesToRead.push(entry.relativePath);
            }
        }
    }

    // Step 3: Read selected files within budget
    let fileContext = "";
    let totalChars = 0;

    // Always include root key files first
    for (const entry of tree) {
        if (!entry.isDirectory && KEY_FILES.has(entry.name)) {
            if (!filesToRead.includes(entry.relativePath)) {
                filesToRead.unshift(entry.relativePath);
            }
        }
    }

    for (const filePath of filesToRead) {
        if (totalChars >= MAX_FILE_CONTENT_CHARS) break;

        const content = await readFileContent(projectRoot, filePath, MAX_LINES_PER_FILE);
        if (!content) continue;

        const trimmed = content.slice(0, MAX_FILE_CONTENT_CHARS - totalChars);
        fileContext += `\n--- ${filePath} ---\n${trimmed}\n`;
        totalChars += trimmed.length;
    }

    // Step 4: Deep analysis with structure + code
    const analysisPrompt = await context.loadPrompt("bootstrap-analysis");
    let analysis: AnalysisResult;
    try {
        const prompt =
            `${analysisPrompt}\n\nDirectory structure:\n${treeText}` +
            (fileContext ? `\n\nFile contents:\n${fileContext}` : "");
        const response = await llm.generate(prompt);
        analysis = parseJsonResponse<AnalysisResult>(response);
    } catch {
        return; // LLM or parsing failure — skip bootstrap
    }

    // Step 4b: Validate and sanitize LLM output
    const validated = validateAnalysisResult(analysis);
    analysis = validated.analysis;

    // Step 5: Create entities in graph
    const codeRepoTagId = await ensureTag(context, CODE_REPO_TAG);
    const techTagId = await ensureTag(context, CODE_REPO_TECHNICAL_TAG);
    const obsTagId = await ensureTag(context, CODE_REPO_OBSERVATION_TAG);

    const moduleNameToId = new Map<string, string>();

    if (analysis.modules) {
        for (const mod of analysis.modules) {
            if (!mod.name) continue;
            const entityId = await findOrCreateEntity(context, "module", mod.name, {
                path: mod.path,
                kind: mod.kind || "subsystem",
                status: "active",
                description: mod.description,
            });
            moduleNameToId.set(mod.name, entityId);
        }
    }

    if (analysis.data_entities) {
        for (const entity of analysis.data_entities) {
            if (!entity.name) continue;
            await findOrCreateEntity(context, "data_entity", entity.name, {
                source: entity.source,
            });
        }
    }

    const conceptNameToId = new Map<string, string>();
    if (analysis.concepts) {
        for (const concept of analysis.concepts) {
            if (!concept.name) continue;
            const entityId = await findOrCreateEntity(context, "concept", concept.name, {
                description: concept.description,
            });
            conceptNameToId.set(concept.name, entityId);
        }
    }

    if (analysis.patterns) {
        for (const pattern of analysis.patterns) {
            if (!pattern.name) continue;
            await findOrCreateEntity(context, "pattern", pattern.name, {
                scope: pattern.scope,
            });
        }
    }

    // Step 6: Create relationships
    if (analysis.relationships) {
        for (const rel of analysis.relationships) {
            if (rel.type !== "contains" && rel.type !== "connects_to" && rel.type !== "implements")
                continue;

            let fromId: string | undefined;
            let toId: string | undefined;

            if (rel.type === "implements") {
                fromId = moduleNameToId.get(rel.from);
                toId = conceptNameToId.get(rel.to);
            } else {
                fromId = moduleNameToId.get(rel.from);
                toId = moduleNameToId.get(rel.to);
            }

            if (!fromId || !toId) continue;
            if (fromId === toId) continue;

            try {
                const edgeData: Record<string, unknown> = {};
                if (rel.description) edgeData.description = rel.description;
                await context.graph.relate(fromId, rel.type, toId, edgeData);
            } catch {
                // Edge may already exist or types mismatch — skip
            }
        }
    }

    // Step 7: Store HEAD commit hash so commit-scanner picks up from here
    try {
        const headOutput = await execGit(["rev-parse", "HEAD"], projectRoot);
        const head = headOutput.trim();
        if (head) {
            await context.setMeta(META_LAST_COMMIT, head);
        }
    } catch {
        // Not a git repo — that's okay
    }

    // Step 8: Write summary observation memory
    const moduleCount = analysis.modules?.length ?? 0;
    const entityCount = analysis.data_entities?.length ?? 0;
    const conceptCount = analysis.concepts?.length ?? 0;
    const patternCount = analysis.patterns?.length ?? 0;
    const summary =
        `Code repo bootstrap complete: identified ${moduleCount} modules, ` +
        `${entityCount} data entities, ${conceptCount} concepts, ` +
        `and ${patternCount} patterns from directory and code analysis. ` +
        `Read ${filesToRead.length} files for deep understanding.`;

    const memoryId = await context.writeMemory({
        content: summary,
        tags: [CODE_REPO_TAG, CODE_REPO_TECHNICAL_TAG, CODE_REPO_OBSERVATION_TAG],
        ownership: {
            domain: context.domain,
            attributes: {
                classification: "observation",
                audience: ["technical"],
                superseded: false,
            },
        },
    });
    await context.tagMemory(memoryId, codeRepoTagId);
    await context.tagMemory(memoryId, techTagId);
    await context.tagMemory(memoryId, obsTagId);
}
