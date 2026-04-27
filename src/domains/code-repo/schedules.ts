import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import type { DomainContext } from "../../core/types.js";
import { CODE_REPO_TAG, CODE_REPO_TECHNICAL_TAG, CODE_REPO_QUESTION_TAG } from "./types.js";
import type { CodeRepoDomainOptions } from "./types.js";
import { ensureTag, findOrCreateEntity } from "./utils.js";

const META_LAST_COMMIT = "code-repo:lastCommitHash";

function execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${error.message}\n${stderr}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

interface FileChange {
    status: "A" | "D" | "M" | "R";
    path: string;
    oldPath?: string;
}

interface CommitChanges {
    hash: string;
    subject: string;
    files: FileChange[];
}

function parseGitLog(output: string): CommitChanges[] {
    const commits: CommitChanges[] = [];
    const lines = output.split("\n");
    let current: CommitChanges | null = null;

    for (const line of lines) {
        if (!line.trim()) continue;

        // Commit header line: "hash subject"
        const headerMatch = line.match(/^([a-f0-9]{40})\s+(.*)$/);
        if (headerMatch) {
            if (current) commits.push(current);
            current = { hash: headerMatch[1], subject: headerMatch[2], files: [] };
            continue;
        }

        // File change line: "A\tpath" or "R100\told\tnew"
        if (current) {
            const parts = line.split("\t");
            if (parts.length >= 2) {
                const statusCode = parts[0].charAt(0);
                if (statusCode === "A" || statusCode === "D" || statusCode === "M") {
                    current.files.push({ status: statusCode, path: parts[1] });
                } else if (statusCode === "R" && parts.length >= 3) {
                    current.files.push({ status: "R", path: parts[2], oldPath: parts[1] });
                }
            }
        }
    }

    if (current) commits.push(current);
    return commits;
}

function inferModuleKind(dirPath: string): string {
    const name = basename(dirPath).toLowerCase();
    if (name.includes("service") || name.includes("api")) return "service";
    if (name.includes("lambda") || name.includes("function")) return "lambda";
    if (name.includes("lib") || name.includes("util") || name.includes("shared")) return "library";
    if (name.includes("pkg") || name.includes("package")) return "package";
    return "subsystem";
}

function collectDirectoryChanges(commits: CommitChanges[]): {
    newDirs: Set<string>;
    deletedDirs: Map<string, Set<string>>;
} {
    const addedFiles = new Map<string, Set<string>>();
    const deletedFiles = new Map<string, Set<string>>();

    for (const commit of commits) {
        for (const file of commit.files) {
            const dir = dirname(file.path);
            if (dir === ".") continue;

            if (file.status === "A") {
                const files = addedFiles.get(dir) ?? new Set();
                files.add(file.path);
                addedFiles.set(dir, files);
            } else if (file.status === "D") {
                const files = deletedFiles.get(dir) ?? new Set();
                files.add(file.path);
                deletedFiles.set(dir, files);
            }
        }
    }

    // New dirs: directories that only appear in additions
    const newDirs = new Set<string>();
    for (const dir of addedFiles.keys()) {
        if (!deletedFiles.has(dir)) {
            newDirs.add(dir);
        }
    }

    return { newDirs, deletedDirs: deletedFiles };
}

export async function scanCommits(
    context: DomainContext,
    options?: CodeRepoDomainOptions,
): Promise<void> {
    const projectRoot = options?.projectRoot;
    if (!projectRoot) return;

    const lastCommitHash = await context.getMeta(META_LAST_COMMIT);

    // First run: store current HEAD and return
    if (!lastCommitHash) {
        try {
            const headOutput = await execGit(["rev-parse", "HEAD"], projectRoot);
            const head = headOutput.trim();
            if (head) {
                await context.setMeta(META_LAST_COMMIT, head);
            }
        } catch {
            // Not a git repo or git not available
        }
        return;
    }

    // Get commits since last scan
    let logOutput: string;
    try {
        logOutput = await execGit(
            ["log", "--name-status", "--format=%H %s", `${lastCommitHash}..HEAD`],
            projectRoot,
        );
    } catch {
        return; // git error — skip this run
    }

    if (!logOutput.trim()) return;

    const commits = parseGitLog(logOutput);
    if (commits.length === 0) return;

    const { newDirs, deletedDirs } = collectDirectoryChanges(commits);

    // Ensure tags
    const codeRepoTagId = await ensureTag(context, CODE_REPO_TAG);
    const techTagId = await ensureTag(context, CODE_REPO_TECHNICAL_TAG);
    const questionTagId = await ensureTag(context, CODE_REPO_QUESTION_TAG);

    // Create module entities for new directories
    for (const dir of newDirs) {
        const kind = inferModuleKind(dir);
        await findOrCreateEntity(context, "module", basename(dir), {
            path: dir,
            kind,
            status: "active",
        });
    }

    // Mark deleted directories as archived
    for (const dir of deletedDirs.keys()) {
        const results = await context.graph.query<{ id: string }>(
            "SELECT id FROM module WHERE path = $1 LIMIT 1",
            [dir],
        );
        if (Array.isArray(results) && results.length > 0) {
            await context.graph.updateNode(results[0].id, { status: "archived" });
        }
    }

    // Create observation memories for significant changes
    if (newDirs.size > 0) {
        const dirList = Array.from(newDirs).slice(0, 10).join(", ");
        const content = `New directories detected: ${dirList}${newDirs.size > 10 ? ` (and ${newDirs.size - 10} more)` : ""}`;
        const memoryId = await context.writeMemory({
            content,
            tags: [CODE_REPO_TAG, CODE_REPO_TECHNICAL_TAG],
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
    }

    if (deletedDirs.size > 0) {
        const dirList = Array.from(deletedDirs.keys()).slice(0, 10).join(", ");
        const content = `Directories removed: ${dirList}${deletedDirs.size > 10 ? ` (and ${deletedDirs.size - 10} more)` : ""}`;
        const memoryId = await context.writeMemory({
            content,
            tags: [CODE_REPO_TAG, CODE_REPO_TECHNICAL_TAG],
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
    }

    // Detect potential business logic changes
    const businessHintPatterns = [
        /enum/i,
        /status/i,
        /state/i,
        /type/i,
        /role/i,
        /permission/i,
        /policy/i,
    ];
    const businessHints: string[] = [];
    for (const commit of commits) {
        for (const file of commit.files) {
            if (file.status !== "A") continue;
            const name = basename(file.path);
            if (businessHintPatterns.some((p) => p.test(name))) {
                businessHints.push(file.path);
            }
        }
    }

    if (businessHints.length > 0) {
        const fileList = businessHints.slice(0, 5).join(", ");
        const memoryId = await context.writeMemory({
            content: `New files with potential business logic significance: ${fileList}. What do these represent?`,
            tags: [CODE_REPO_TAG, CODE_REPO_QUESTION_TAG],
            ownership: {
                domain: context.domain,
                attributes: {
                    classification: "question",
                    audience: ["technical", "business"],
                    superseded: false,
                },
            },
        });
        await context.tagMemory(memoryId, codeRepoTagId);
        await context.tagMemory(memoryId, questionTagId);
    }

    // Store new HEAD
    const newHead = commits[0].hash;
    await context.setMeta(META_LAST_COMMIT, newHead);
}

export async function detectDrift(
    context: DomainContext,
    options?: CodeRepoDomainOptions,
): Promise<void> {
    const projectRoot = options?.projectRoot;
    if (!projectRoot) return;

    // Get non-superseded decision memories
    const decisions = await context.getMemories({
        tags: [CODE_REPO_TAG],
        attributes: { classification: "decision", superseded: false },
    });

    if (decisions.length === 0) return;

    const codeRepoTagId = await ensureTag(context, CODE_REPO_TAG);
    const techTagId = await ensureTag(context, CODE_REPO_TECHNICAL_TAG);

    for (const decision of decisions) {
        // Find entity nodes linked to this decision via about_entity edges
        const edges = await context.getNodeEdges(decision.id, "out");
        const entityEdges = edges.filter((e) => {
            const edgeId = typeof e.id === "string" ? e.id : String(e.id);
            return edgeId.startsWith("about_entity:");
        });

        for (const edge of entityEdges) {
            const entityId = typeof edge.out === "string" ? edge.out : String(edge.out);
            if (!entityId.startsWith("module:")) continue;

            const entity = await context.graph.getNode(entityId);
            if (!entity) continue;

            const entityData = entity as Record<string, unknown>;
            const entityPath = entityData.path as string | undefined;
            if (!entityPath) continue;

            const fullPath = join(projectRoot, entityPath);
            if (!existsSync(fullPath)) {
                const entityName = entityData.name as string;
                const memoryId = await context.writeMemory({
                    content: `Structural drift detected: module "${entityName}" at path "${entityPath}" no longer exists, but is referenced in decision: "${decision.content.substring(0, 100)}..."`,
                    tags: [CODE_REPO_TAG, CODE_REPO_TECHNICAL_TAG],
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

                // Link observation to the decision it's about
                await context.graph.relate(memoryId, "raises", decision.id);
            }
        }
    }
}
