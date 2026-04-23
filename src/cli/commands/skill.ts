import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandHandler } from "../types.js";

interface SkillIndexEntry {
    domain: string;
    id: string;
    name: string;
    description: string;
}

async function loadOverview(): Promise<string> {
    try {
        const cliDir = dirname(fileURLToPath(import.meta.url));
        return await readFile(join(cliDir, "..", "skills", "cli-guide.md"), "utf-8");
    } catch {
        return "";
    }
}

const skillCommand: CommandHandler = async (engine, parsed) => {
    const registry = engine.getDomainRegistry();
    const target = parsed.args[0];

    if (target) {
        const matches: Array<{ domain: string; skillId: string; content: string | null }> = [];
        for (const domain of registry.list()) {
            const skill = registry.getSkill(domain.id, target);
            if (!skill) continue;
            const externals = registry.getExternalSkills(domain.id);
            if (!externals.some((s) => s.id === target)) continue;
            const content = await registry.getSkillContent(domain.id, target);
            matches.push({ domain: domain.id, skillId: target, content });
        }

        if (matches.length === 0) {
            return {
                output: { error: `Skill "${target}" not found in any registered domain` },
                exitCode: 1,
            };
        }

        if (matches.length > 1) {
            return {
                output: {
                    error: `Skill id "${target}" is ambiguous`,
                    candidates: matches.map((m) => ({ domain: m.domain, id: m.skillId })),
                },
                exitCode: 1,
            };
        }

        const [only] = matches;
        const skill = registry.getSkill(only.domain, only.skillId)!;
        return {
            output: { ...skill, domain: only.domain, content: only.content ?? "" },
            exitCode: 0,
            formatCommand: "domain-skill",
        };
    }

    const overview = await loadOverview();
    const index: SkillIndexEntry[] = [];
    for (const domain of registry.list()) {
        for (const skill of registry.getExternalSkills(domain.id)) {
            index.push({
                domain: domain.id,
                id: skill.id,
                name: skill.name,
                description: skill.description,
            });
        }
    }

    return {
        output: { overview, index },
        exitCode: 0,
        formatCommand: "skill-index",
    };
};

export { skillCommand };
export type { SkillIndexEntry };
