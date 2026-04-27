import type {
    LLMAdapter,
    ScoredMemory,
    ModelLevel,
    AgentRunSpec,
    AgentRunResult,
} from "../../core/types.js";

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
    // Every LLMAdapter method is optional. NoLlmAdapter implements none of
    // them, so `if (context.llm.<method>)` short-circuits cleanly in every
    // pluggable code path. Callers that invoke an LLM method without first
    // checking presence are buggy by definition.
}

export { NoLlmAdapter };
// Re-export for symmetry with other imports; some callers want typed nulls.
export type { LLMAdapter, ScoredMemory, ModelLevel, AgentRunSpec, AgentRunResult };
