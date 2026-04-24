import type { LLMAdapter, ScoredMemory, ModelLevel, AgentRunSpec, AgentRunResult } from "../../core/types.js";

/**
 * `NoLlmAdapter` is an opt-out adapter. Every method throws with a stack
 * trace pointing at the caller, making accidental LLM usage impossible to
 * miss during ingestion or other batch paths that should be LLM-free.
 *
 * Use this adapter when a caller has not *explicitly* opted into LLM
 * invocation. Optional adapter methods (extractStructured, assess, rerank,
 * synthesize, generate, runAgent, withLevel) are intentionally omitted so
 * that `if (context.llm.extractStructured)` checks short-circuit cleanly.
 *
 * Required methods (`extract`, `consolidate`) throw. If a code path calls
 * them without an opt-in, that path is buggy — the throw surfaces it loudly.
 */
class NoLlmAdapter implements LLMAdapter {
    private fail(method: string): never {
        throw new Error(
            `LLM.${method}() was called but no LLM provider is configured. ` +
            `LLM usage must be explicitly enabled by the caller (e.g. pass ` +
            `--judge or construct an adapter). This invariant prevents silent ` +
            `LLM fallbacks during supposedly LLM-free ingestion paths.`,
        );
    }

    async extract(_text: string, _prompt?: string): Promise<string[]> {
        this.fail("extract");
    }

    async consolidate(_memories: string[]): Promise<string> {
        this.fail("consolidate");
    }

    // Optional methods are intentionally not implemented. Their absence
    // satisfies `if (context.llm.extractStructured)` guards (value is
    // `undefined` on this adapter), so plugins that gate optional LLM usage
    // behind that check will skip the LLM branch.
}

export { NoLlmAdapter };
// Re-export for symmetry with other imports; some callers want typed nulls.
export type { LLMAdapter, ScoredMemory, ModelLevel, AgentRunSpec, AgentRunResult };
