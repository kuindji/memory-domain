import type { DebugConfig, DebugTools, LLMAdapter, ModelLevel, ScoredMemory } from "./types.js";

function formatDetails(details?: Record<string, unknown>): string {
    if (!details) return "";

    const parts = Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`);

    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message.replace(/\s+/g, " ").trim();
    }
    if (typeof error === "string") {
        return error.replace(/\s+/g, " ").trim();
    }
    return "Unknown error";
}

function createDebugTools(scope: string, config?: DebugConfig): DebugTools {
    const timingEnabled = config?.timing === true;

    return {
        timingEnabled,

        log(label: string, details?: Record<string, unknown>): void {
            if (!timingEnabled) return;
            console.log(`[memory-domain timing] ${scope}.${label}${formatDetails(details)}`);
        },

        async time<T>(
            label: string,
            fn: () => Promise<T>,
            details?: Record<string, unknown>,
        ): Promise<T> {
            if (!timingEnabled) return fn();

            const startedAt = performance.now();
            try {
                const result = await fn();
                const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
                console.log(
                    `[memory-domain timing] ${scope}.${label} durationMs=${durationMs}${formatDetails(details)}`,
                );
                return result;
            } catch (error) {
                const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
                const errorName = error instanceof Error ? error.name : "UnknownError";
                const errorMessage = JSON.stringify(getErrorMessage(error));
                console.log(
                    `[memory-domain timing] ${scope}.${label} durationMs=${durationMs} status=error error=${errorName} errorMessage=${errorMessage}${formatDetails(details)}`,
                );
                throw error;
            }
        },
    };
}

function wrapLLMAdapter(adapter: LLMAdapter, debug: DebugTools, scope: string): LLMAdapter {
    const wrapped: LLMAdapter = {
        extract(text: string, prompt?: string): Promise<string[]> {
            return debug.time(`${scope}.extract`, () => adapter.extract(text, prompt), {
                chars: text.length,
            });
        },

        consolidate(memories: string[]): Promise<string> {
            const chars = memories.reduce((sum, memory) => sum + memory.length, 0);
            return debug.time(`${scope}.consolidate`, () => adapter.consolidate(memories), {
                memories: memories.length,
                chars,
            });
        },
    };

    if (adapter.extractStructured) {
        wrapped.extractStructured = (
            text: string,
            schema: string,
            prompt?: string,
        ): Promise<unknown[]> =>
            debug.time(
                `${scope}.extractStructured`,
                () => adapter.extractStructured!(text, schema, prompt),
                {
                    chars: text.length,
                    schemaChars: schema.length,
                },
            );
    }

    if (adapter.assess) {
        wrapped.assess = (content: string, existingContext: string[]): Promise<number> =>
            debug.time(`${scope}.assess`, () => adapter.assess!(content, existingContext), {
                chars: content.length,
                contextItems: existingContext.length,
            });
    }

    if (adapter.rerank) {
        wrapped.rerank = (
            query: string,
            candidates: { id: string; content: string }[],
        ): Promise<string[]> =>
            debug.time(`${scope}.rerank`, () => adapter.rerank!(query, candidates), {
                chars: query.length,
                candidates: candidates.length,
            });
    }

    if (adapter.synthesize) {
        wrapped.synthesize = (
            query: string,
            memories: ScoredMemory[],
            tagContext?: string[],
            instructions?: string,
        ): Promise<string> =>
            debug.time(
                `${scope}.synthesize`,
                () => adapter.synthesize!(query, memories, tagContext, instructions),
                {
                    chars: query.length,
                    memories: memories.length,
                    tags: tagContext?.length ?? 0,
                },
            );
    }

    if (adapter.generate) {
        wrapped.generate = (prompt: string): Promise<string> =>
            debug.time(`${scope}.generate`, () => adapter.generate!(prompt), {
                chars: prompt.length,
            });
    }

    if (adapter.withLevel) {
        wrapped.withLevel = (level: ModelLevel): LLMAdapter => {
            const next = adapter.withLevel!(level);
            return wrapLLMAdapter(next, debug, `${scope}:${level}`);
        };
    }

    return wrapped;
}

export { createDebugTools, wrapLLMAdapter };
