#!/usr/bin/env node
import * as p from "@clack/prompts";
import { loadConfig } from "../config-loader.js";
import type { MemoryEngine } from "../core/engine.js";
import type { DomainSummary } from "../core/types.js";

function parseArgs(argv: string[]): { config?: string } {
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--config" && args[i + 1]) {
            return { config: args[i + 1] };
        }
        if (args[i]?.startsWith("--config=")) {
            return { config: args[i].slice("--config=".length) };
        }
    }
    return {};
}

function isCancel(value: unknown): value is symbol {
    return p.isCancel(value);
}

async function selectMode(): Promise<"ask" | "build-context" | "ingest" | "quit" | symbol> {
    return p.select({
        message: "What would you like to do?",
        options: [
            { value: "ask" as const, label: "Ask", hint: "multi-round Q&A over memories" },
            {
                value: "build-context" as const,
                label: "Build Context",
                hint: "generate a context block",
            },
            { value: "ingest" as const, label: "Ingest", hint: "store new memories" },
            { value: "quit" as const, label: "Quit" },
        ],
    });
}

async function selectDomains(summaries: DomainSummary[]): Promise<string[] | symbol> {
    if (summaries.length === 0) {
        p.log.warn("No domains registered.");
        return [];
    }

    if (summaries.length === 1) {
        p.log.info(`Using domain: ${summaries[0].name}`);
        return [summaries[0].id];
    }

    const selected = await p.multiselect({
        message: "Select domains (space to toggle, enter to confirm)",
        options: summaries.map((d) => ({
            value: d.id,
            label: d.name,
            hint: d.description,
        })),
        required: false,
    });

    return selected;
}

async function runAsk(engine: MemoryEngine, domains: string[]): Promise<void> {
    const question = await p.text({
        message: "Enter your question",
        validate: (v) => (!v?.trim() ? "Question is required" : undefined),
    });

    if (isCancel(question)) return;

    const spin = p.spinner();
    spin.start("Thinking...");

    try {
        const result = await engine.ask(question, {
            domains: domains.length > 0 ? domains : undefined,
        });
        spin.stop("Done");

        p.log.message(result.answer);
        const turns = result.turns?.length ?? 0;
        p.log.info(
            `${turns} turn${turns !== 1 ? "s" : ""} | ${result.rounds} round${result.rounds !== 1 ? "s" : ""}`,
        );
    } catch (err) {
        spin.stop("Failed");
        p.log.error(err instanceof Error ? err.message : String(err));
    }
}

async function runBuildContext(engine: MemoryEngine, domains: string[]): Promise<void> {
    const text = await p.text({
        message: "Enter text to build context for",
        validate: (v) => (!v?.trim() ? "Text is required" : undefined),
    });

    if (isCancel(text)) return;

    const spin = p.spinner();
    spin.start("Building context...");

    try {
        const result = await engine.buildContext(text, {
            domains: domains.length > 0 ? domains : undefined,
        });
        spin.stop("Done");

        p.log.message(result.context);
        p.log.info(`${result.memories.length} memories | ${result.totalTokens} tokens`);
    } catch (err) {
        spin.stop("Failed");
        p.log.error(err instanceof Error ? err.message : String(err));
    }
}

async function runIngest(engine: MemoryEngine, domains: string[]): Promise<void> {
    let more = true;
    while (more) {
        const text = await p.text({
            message: "Enter text to ingest",
            validate: (v) => (!v?.trim() ? "Text is required" : undefined),
        });

        if (isCancel(text)) return;

        const tags = await p.text({
            message: "Tags (comma-separated, optional)",
        });

        if (isCancel(tags)) return;

        const spin = p.spinner();
        spin.start("Ingesting...");

        try {
            const result = await engine.ingest(text, {
                domains: domains.length > 0 ? domains : undefined,
                tags: tags.trim() ? tags.split(",").map((t) => t.trim()) : undefined,
            });
            spin.stop("Done");

            if (result.action === "stored") {
                p.log.success(`Stored as ${result.id}`);
            } else if (result.action === "reinforced") {
                p.log.info(`Reinforced existing memory ${result.existingId}`);
            } else {
                p.log.warn(`Skipped (duplicate of ${result.existingId})`);
            }
        } catch (err) {
            spin.stop("Failed");
            p.log.error(err instanceof Error ? err.message : String(err));
        }

        const again = await p.confirm({ message: "Ingest another?" });
        if (isCancel(again) || !again) {
            more = false;
        }
    }
}

async function main(): Promise<void> {
    const { config } = parseArgs(process.argv);

    p.intro("memory-domain");

    let engine: MemoryEngine;
    try {
        engine = await loadConfig(undefined, config);
    } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
        p.outro("Failed to load config");
        process.exit(1);
    }

    const summaries = engine.getDomainRegistry().listSummaries();

    try {
        while (true) {
            const mode = await selectMode();

            if (isCancel(mode) || mode === "quit") break;

            const domains = await selectDomains(summaries);
            if (isCancel(domains)) break;

            if (mode === "ask") {
                await runAsk(engine, domains);
            } else if (mode === "build-context") {
                await runBuildContext(engine, domains);
            } else if (mode === "ingest") {
                await runIngest(engine, domains);
            }
        }
    } finally {
        await engine.close();
    }

    p.outro("Goodbye");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
