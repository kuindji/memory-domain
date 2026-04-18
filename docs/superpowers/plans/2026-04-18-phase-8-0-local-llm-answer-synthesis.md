# Phase 8.0 — Local-LLM Answer-Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional local-LLM answer-synthesis stage after path-memory retrieval, producing dual-metric LOCOMO scores (retrieval-only vs. LLM-synthesized) so we can measure the lift from synthesis on a 1542-probe run.

**Architecture:** An Ollama sidecar exposes `qwen2.5:1.5b-instruct` over HTTP. A thin `LlmSynthesizer` adapter wraps `/api/chat`. The LOCOMO adapter gains an optional synthesizer hook; the scorer computes two parallel metric bundles (`retrieval.*` and `synth.*`) plus abstention counters. Retrieval pipeline is held fixed at the Phase 2.14 default.

**Tech Stack:** Bun + TypeScript, `bun test` for unit tests, built-in `fetch` for Ollama HTTP, existing `getEmbedder()` for retrieval, existing `loadLocomo`/`loadMsc`/LongMemEval loaders.

**Spec:** `docs/superpowers/specs/2026-04-18-phase-8-0-local-llm-answer-synthesis-design.md`

---

## Preconditions

- Node/Bun toolchain already set up for the repo (standard for this codebase).
- Ollama installed. If not: `brew install ollama` then `ollama serve` in a separate terminal. This plan assumes the engineer runs `ollama serve` and `ollama pull qwen2.5:1.5b-instruct` (and `qwen2.5:3b-instruct`) before the evaluation tasks. Unit tests do NOT require Ollama (mocked).
- LOCOMO JSON already placed at `experiments/path-memory-smoketest/data/locomo.json` per Phase 7.5 (existing precondition).

---

## File Structure

**Create:**
- `experiments/path-memory-smoketest/src/llm-synthesizer.ts` — `LlmSynthesizer` interface, `OllamaSynthesizer` class, prompt builder, abstention detector.
- `experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts` — prompt / parsing / abstention tests with mocked `fetch`.
- `experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts` — synth metric bundle + aggregator tests.
- `experiments/path-memory-smoketest/scripts/phase-8-0-locomo-synth.ts` — primary 1542-probe runner.
- `experiments/path-memory-smoketest/scripts/phase-8-0-confounder.ts` — 150-probe 3B slice runner.
- `experiments/path-memory-smoketest/notes/phase-8-0-reading.md` — writeup (authored in final task).

**Modify:**
- `experiments/path-memory-smoketest/eval/locomo-adapter.ts` — optional `synthesizer` in `LocomoAdapterOptions`; new `synthesizedAnswer` + `synthMs` fields on `LocomoQuestionResult`.
- `experiments/path-memory-smoketest/eval/locomo-score.ts` — new `LocomoSynthMetricBundle`, optional `synthMetrics` on `LocomoScore`, abstention counters, updated aggregators.

---

## Task 1: Define `LlmSynthesizer` interface and Ollama HTTP adapter (TDD)

**Files:**
- Create: `experiments/path-memory-smoketest/src/llm-synthesizer.ts`
- Test: `experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts`

- [ ] **Step 1.1: Write the failing prompt-builder test**

Create `experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts`:

```ts
import { describe, test, expect, mock } from "bun:test";
import {
    buildSynthesisPrompt,
    detectAbstention,
    OllamaSynthesizer,
} from "../src/llm-synthesizer.js";

describe("buildSynthesisPrompt", () => {
    test("numbers claims 1..K and embeds the question", () => {
        const { system, user } = buildSynthesisPrompt(
            "Where did Alice move?",
            ["Alice moved to Boston.", "Alice bought a dog."],
        );
        expect(system).toContain('respond exactly "Not mentioned"');
        expect(system).toContain("≤15 tokens");
        expect(user).toContain("1. Alice moved to Boston.");
        expect(user).toContain("2. Alice bought a dog.");
        expect(user).toContain("Question: Where did Alice move?");
        expect(user.trimEnd().endsWith("Answer:")).toBe(true);
    });

    test("handles empty claim list by emitting an explicit no-memory marker", () => {
        const { user } = buildSynthesisPrompt("Who?", []);
        expect(user).toContain("Memory:\n(none)");
    });
});

describe("detectAbstention", () => {
    test("case-insensitive exact match on 'not mentioned'", () => {
        expect(detectAbstention("Not mentioned")).toBe(true);
        expect(detectAbstention("  not mentioned  ")).toBe(true);
        expect(detectAbstention("NOT MENTIONED")).toBe(true);
    });

    test("partial or decorated answers are not abstentions", () => {
        expect(detectAbstention("Not mentioned in the memory.")).toBe(false);
        expect(detectAbstention("I don't know")).toBe(false);
        expect(detectAbstention("Boston")).toBe(false);
        expect(detectAbstention("")).toBe(false);
    });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `bun test experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts`
Expected: FAIL with "Cannot find module '../src/llm-synthesizer.js'"

- [ ] **Step 1.3: Implement prompt builder and abstention detector**

Create `experiments/path-memory-smoketest/src/llm-synthesizer.ts`:

```ts
// Phase 8.0 — local-LLM answer-synthesis adapter.
//
// Wraps an Ollama sidecar running a small instruction-tuned model
// (qwen2.5:1.5b-instruct by default). Keeps the adapter surface tiny
// so the harness stays testable without a live server.

export type SynthesisPrompt = {
    system: string;
    user: string;
};

const SYSTEM_PROMPT = [
    "You answer questions using only the provided memory snippets.",
    'If the snippets do not support an answer, respond exactly "Not mentioned".',
    "Answer in ≤15 tokens. Do not explain.",
].join("\n");

export function buildSynthesisPrompt(question: string, claimTexts: string[]): SynthesisPrompt {
    const memoryBlock =
        claimTexts.length === 0
            ? "(none)"
            : claimTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const user = `Memory:\n${memoryBlock}\n\nQuestion: ${question}\nAnswer:`;
    return { system: SYSTEM_PROMPT, user };
}

const ABSTENTION_CANONICAL = "not mentioned";

export function detectAbstention(output: string): boolean {
    return output.trim().toLowerCase() === ABSTENTION_CANONICAL;
}

export type SynthesisResult = {
    answer: string;
    abstained: boolean;
    ms: number;
};

export type LlmSynthesizer = {
    synthesize(question: string, claimTexts: string[]): Promise<SynthesisResult>;
    healthCheck(): Promise<void>;
};

export type OllamaOptions = {
    // Base URL of the Ollama server. Defaults to http://127.0.0.1:11434.
    baseUrl?: string;
    // Tag name passed to /api/chat. e.g. "qwen2.5:1.5b-instruct".
    model: string;
    // Max tokens in the completion. Defensive cap on top of the prompt's
    // ≤15-token instruction.
    maxTokens?: number;
    // Sampling temperature. 0 for determinism.
    temperature?: number;
    // Optional fetch override for tests.
    fetchFn?: typeof fetch;
};

type ChatResponse = {
    message?: { content?: string };
    done?: boolean;
};

export class OllamaSynthesizer implements LlmSynthesizer {
    private readonly baseUrl: string;
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;
    private readonly fetchFn: typeof fetch;

    constructor(options: OllamaOptions) {
        this.baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
        this.model = options.model;
        this.maxTokens = options.maxTokens ?? 30;
        this.temperature = options.temperature ?? 0;
        this.fetchFn = options.fetchFn ?? fetch;
    }

    async healthCheck(): Promise<void> {
        const res = await this.fetchFn(`${this.baseUrl}/api/tags`);
        if (!res.ok) {
            throw new Error(`Ollama health check failed: ${res.status} ${res.statusText}`);
        }
    }

    async synthesize(question: string, claimTexts: string[]): Promise<SynthesisResult> {
        const { system, user } = buildSynthesisPrompt(question, claimTexts);
        const body = {
            model: this.model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            stream: false,
            options: {
                temperature: this.temperature,
                num_predict: this.maxTokens,
            },
        };

        const start = performance.now();
        const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Ollama /api/chat failed: ${res.status} ${res.statusText} — ${text}`);
        }
        const json = (await res.json()) as ChatResponse;
        const ms = performance.now() - start;
        const answer = (json.message?.content ?? "").trim();
        return { answer, abstained: detectAbstention(answer), ms };
    }
}
```

- [ ] **Step 1.4: Run the prompt/abstention tests to verify green**

Run: `bun test experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 1.5: Add a failing HTTP-adapter test with mocked fetch**

Append to `experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts`:

```ts
describe("OllamaSynthesizer.synthesize", () => {
    test("POSTs chat messages and extracts trimmed content", async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            const body = init?.body ? JSON.parse(init.body as string) : undefined;
            calls.push({ url, body });
            return new Response(
                JSON.stringify({ message: { content: "  Boston  " }, done: true }),
                { status: 200, headers: { "content-type": "application/json" } },
            );
        }) as typeof fetch;

        const s = new OllamaSynthesizer({ model: "qwen2.5:1.5b-instruct", fetchFn: fakeFetch });
        const result = await s.synthesize("Where did Alice move?", ["Alice moved to Boston."]);

        expect(result.answer).toBe("Boston");
        expect(result.abstained).toBe(false);
        expect(result.ms).toBeGreaterThanOrEqual(0);
        expect(calls.length).toBe(1);
        expect(calls[0].url).toContain("/api/chat");
        const sentBody = calls[0].body as { model: string; messages: { role: string }[] };
        expect(sentBody.model).toBe("qwen2.5:1.5b-instruct");
        expect(sentBody.messages.map((m) => m.role)).toEqual(["system", "user"]);
    });

    test("marks abstention when model outputs 'Not mentioned'", async () => {
        const fakeFetch = (async () =>
            new Response(JSON.stringify({ message: { content: "Not mentioned" }, done: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
            })) as typeof fetch;

        const s = new OllamaSynthesizer({ model: "qwen2.5:1.5b-instruct", fetchFn: fakeFetch });
        const result = await s.synthesize("Adversarial?", ["Unrelated fact."]);
        expect(result.abstained).toBe(true);
        expect(result.answer).toBe("Not mentioned");
    });

    test("throws with a descriptive message on non-2xx responses", async () => {
        const fakeFetch = (async () =>
            new Response("model not found", {
                status: 404,
                statusText: "Not Found",
            })) as typeof fetch;

        const s = new OllamaSynthesizer({ model: "nope:1b", fetchFn: fakeFetch });
        await expect(s.synthesize("q", [])).rejects.toThrow(/Ollama \/api\/chat failed: 404/);
    });
});
```

- [ ] **Step 1.6: Run the HTTP tests to verify green**

Run: `bun test experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts`
Expected: PASS, 7 tests total.

- [ ] **Step 1.7: Lint + typecheck**

Run:
```bash
bun run typecheck
bun run lint
```
Expected: no errors.

- [ ] **Step 1.8: Format and commit**

```bash
bun run format
git add experiments/path-memory-smoketest/src/llm-synthesizer.ts \
        experiments/path-memory-smoketest/tests/llm-synthesizer.test.ts
git commit -m "feat(path-memory): Phase 8.0 — LlmSynthesizer + Ollama adapter"
```

---

## Task 2: Extend LOCOMO adapter with optional synthesizer hook

**Files:**
- Modify: `experiments/path-memory-smoketest/eval/locomo-adapter.ts`

- [ ] **Step 2.1: Add a failing integration test for the synthesizer hook**

Create `experiments/path-memory-smoketest/tests/locomo-adapter-synth.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { runLocomoConversation } from "../eval/locomo-adapter.js";
import type { LlmSynthesizer, SynthesisResult } from "../src/llm-synthesizer.js";
import { makeFakeEmbedder } from "./helpers.js";
import type { LocomoConversation } from "../data/locomo-loader.js";

function stubSynthesizer(answer: string): LlmSynthesizer {
    return {
        async synthesize(question: string, claimTexts: string[]): Promise<SynthesisResult> {
            void question;
            void claimTexts;
            return { answer, abstained: answer.toLowerCase() === "not mentioned", ms: 1 };
        },
        async healthCheck(): Promise<void> {},
    };
}

const CONV: LocomoConversation = {
    sampleId: "s1",
    skippedTurns: 0,
    sessions: [
        {
            sessionIndex: 0,
            timestamp: 1_700_000_000_000,
            turns: [
                { speaker: "A", diaId: "d1", text: "Alice moved to Boston in 2023." },
                { speaker: "A", diaId: "d2", text: "Alice adopted a dog." },
            ],
        },
    ],
    qa: [
        {
            category: "single-session-user",
            question: "Where did Alice move?",
            goldAnswer: "Boston",
            adversarial: false,
            adversarialAnswer: "",
            evidenceDiaIds: ["d1"],
        },
    ],
};

describe("runLocomoConversation — synthesizer hook", () => {
    test("populates synthesizedAnswer when synthesizer is provided", async () => {
        const embedder = makeFakeEmbedder();
        const result = await runLocomoConversation(CONV, {
            embedder,
            synthesizer: stubSynthesizer("Boston"),
        });
        expect(result.questions.length).toBe(1);
        const q = result.questions[0];
        expect(q.synthesizedAnswer).toBe("Boston");
        expect(q.synthAbstained).toBe(false);
        expect(q.synthMs).toBeGreaterThanOrEqual(0);
    });

    test("leaves synthesizedAnswer undefined when no synthesizer", async () => {
        const embedder = makeFakeEmbedder();
        const result = await runLocomoConversation(CONV, { embedder });
        const q = result.questions[0];
        expect(q.synthesizedAnswer).toBeUndefined();
        expect(q.synthAbstained).toBeUndefined();
        expect(q.synthMs).toBeUndefined();
    });
});
```

The fixture above mirrors the real `LocomoConversation` shape (`sessions[*].turns[*]` with `speaker`/`diaId`/`text`) and `LocomoQA` (including the required `adversarialAnswer`). If `turnsToClaims` surprises the fixture (e.g. filters turns unexpectedly), inspect `data/locomo-loader.ts` and adjust — do not mutate the type.

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `bun test experiments/path-memory-smoketest/tests/locomo-adapter-synth.test.ts`
Expected: FAIL — either on `synthesizer` not being a valid option, or on `synthesizedAnswer` field missing.

- [ ] **Step 2.3: Extend `LocomoAdapterOptions` and `LocomoQuestionResult`**

In `experiments/path-memory-smoketest/eval/locomo-adapter.ts`, update imports and types:

```ts
import type { LlmSynthesizer } from "../src/llm-synthesizer.js";
```

Extend `LocomoAdapterOptions`:

```ts
export type LocomoAdapterOptions = {
    embedder: EmbeddingAdapter;
    retrievalOptions?: RetrievalOptions;
    maxClaimsPerQuestion?: number;
    // Optional post-retrieval answer synthesizer. When set, each question's
    // retrieved claim texts are passed to the synthesizer and the result is
    // stored on the question. Phase 8.0.
    synthesizer?: LlmSynthesizer;
};
```

Extend `LocomoQuestionResult` with three optional fields:

```ts
export type LocomoQuestionResult = {
    // ...existing fields unchanged...
    ingestMs: number;
    retrieveMs: number;
    // Phase 8.0 — only populated when `synthesizer` is provided.
    synthesizedAnswer?: string;
    synthAbstained?: boolean;
    synthMs?: number;
};
```

- [ ] **Step 2.4: Wire the synthesizer into the question loop**

Inside `runLocomoConversation`, after `retrievedClaimTexts` is assembled and before the `questions.push({ ... })`, add:

```ts
let synthesizedAnswer: string | undefined;
let synthAbstained: boolean | undefined;
let synthMs: number | undefined;
if (opts.synthesizer !== undefined) {
    const res = await opts.synthesizer.synthesize(qa.question, retrievedClaimTexts);
    synthesizedAnswer = res.answer;
    synthAbstained = res.abstained;
    synthMs = res.ms;
}
```

Then include these three fields in the `questions.push({ ... })` object.

- [ ] **Step 2.5: Run the integration tests to verify green**

Run: `bun test experiments/path-memory-smoketest/tests/locomo-adapter-synth.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 2.6: Run the full path-memory-smoketest suite to confirm no regression**

Run: `cd experiments/path-memory-smoketest && bun test`
Expected: all existing tests still PASS.

- [ ] **Step 2.7: Lint, typecheck, format, commit**

```bash
bun run typecheck
bun run lint
bun run format
git add experiments/path-memory-smoketest/eval/locomo-adapter.ts \
        experiments/path-memory-smoketest/tests/locomo-adapter-synth.test.ts
git commit -m "feat(path-memory): Phase 8.0 — LOCOMO adapter synthesizer hook"
```

---

## Task 3: Add `synth.*` metric bundle to LOCOMO scorer

**Files:**
- Modify: `experiments/path-memory-smoketest/eval/locomo-score.ts`
- Test: `experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts`

- [ ] **Step 3.1: Write failing tests for synth metrics on a single score**

Create `experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { scoreLocomoResult } from "../eval/locomo-score.js";
import type { LocomoQuestionResult } from "../eval/locomo-adapter.js";

function base(overrides: Partial<LocomoQuestionResult>): LocomoQuestionResult {
    return {
        sampleId: "s1",
        questionIndex: 0,
        category: "cat-1",
        questionText: "q?",
        goldAnswer: "Boston",
        adversarial: false,
        evidenceDiaIds: ["d1"],
        ingestedClaimCount: 0,
        topPaths: [],
        retrievedClaimIds: [],
        retrievedClaimTexts: ["Alice moved to Boston in 2023."],
        retrievedDiaIds: ["d1"],
        ingestMs: 0,
        retrieveMs: 0,
        ...overrides,
    };
}

describe("scoreLocomoResult — synth bundle", () => {
    test("synthMetrics is undefined when no synthesizedAnswer", () => {
        const s = scoreLocomoResult(base({}));
        expect(s.synthMetrics).toBeUndefined();
    });

    test("synth contain hits when gold appears in synthesizedAnswer", () => {
        const s = scoreLocomoResult(
            base({ synthesizedAnswer: "Boston", synthAbstained: false, synthMs: 1 }),
        );
        expect(s.synthMetrics).toBeDefined();
        expect(s.synthMetrics!.substringContainment).toBe(true);
        expect(s.synthMetrics!.abstained).toBe(false);
        expect(s.synthMetrics!.falseAbstention).toBe(false);
    });

    test("synth contain misses when synthesizer rephrases away from gold", () => {
        const s = scoreLocomoResult(
            base({
                synthesizedAnswer: "Massachusetts",
                synthAbstained: false,
                synthMs: 1,
            }),
        );
        expect(s.synthMetrics!.substringContainment).toBe(false);
    });

    test("abstention on answerable question is flagged as falseAbstention", () => {
        const s = scoreLocomoResult(
            base({
                synthesizedAnswer: "Not mentioned",
                synthAbstained: true,
                synthMs: 1,
            }),
        );
        expect(s.synthMetrics!.abstained).toBe(true);
        expect(s.synthMetrics!.falseAbstention).toBe(true);
    });

    test("abstention on adversarial question is not falseAbstention", () => {
        const s = scoreLocomoResult(
            base({
                adversarial: true,
                evidenceDiaIds: [],
                synthesizedAnswer: "Not mentioned",
                synthAbstained: true,
                synthMs: 1,
            }),
        );
        expect(s.synthMetrics!.abstained).toBe(true);
        expect(s.synthMetrics!.falseAbstention).toBe(false);
    });
});
```

- [ ] **Step 3.2: Run the tests to verify failure**

Run: `bun test experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts`
Expected: FAIL — `synthMetrics` does not exist on `LocomoScore`.

- [ ] **Step 3.3: Add `LocomoSynthMetricBundle` and populate in `scoreLocomoResult`**

In `experiments/path-memory-smoketest/eval/locomo-score.ts`, add the new type after `LocomoMetricBundle`:

```ts
export type LocomoSynthMetricBundle = {
    substringContainment: boolean;
    tokenRecall: number;
    tokenF1: number;
    fullTokenCoverage: boolean;
    goldTokenCount: number;
    answerTokenCount: number;
    abstained: boolean;
    // True when the model abstained on a question that has gold evidence
    // (adversarial === false). A high rate is a kill-signal for the phase.
    falseAbstention: boolean;
    synthMs: number;
};
```

Extend `LocomoScore`:

```ts
export type LocomoScore = {
    sampleId: string;
    questionIndex: number;
    category: string;
    adversarial: boolean;
    metrics: LocomoMetricBundle;
    synthMetrics?: LocomoSynthMetricBundle;
};
```

Add a scoring helper and call it from `scoreLocomoResult`:

```ts
function scoreSynthMetrics(result: LocomoQuestionResult): LocomoSynthMetricBundle | undefined {
    if (result.synthesizedAnswer === undefined) return undefined;
    const answer = result.synthesizedAnswer;
    const answerLower = answer.toLowerCase();
    const goldLower = result.goldAnswer.toLowerCase().trim();
    const substringContainment = goldLower.length > 0 && answerLower.includes(goldLower);

    const goldTokens = tokenize(result.goldAnswer);
    const answerTokens = tokenize(answer);
    let tokenRecall = 0;
    let tokenF1 = 0;
    let fullTokenCoverage = false;
    if (goldTokens.length > 0) {
        const answerSet = new Set(answerTokens);
        let hits = 0;
        for (const t of goldTokens) if (answerSet.has(t)) hits += 1;
        tokenRecall = hits / goldTokens.length;
        fullTokenCoverage = hits === goldTokens.length;
        const intersection = multisetIntersection(goldTokens, answerTokens);
        const precision = answerTokens.length > 0 ? intersection / answerTokens.length : 0;
        const recallMultiset = intersection / goldTokens.length;
        tokenF1 =
            precision + recallMultiset > 0
                ? (2 * precision * recallMultiset) / (precision + recallMultiset)
                : 0;
    }

    const abstained = result.synthAbstained === true;
    const falseAbstention = abstained && !result.adversarial;

    return {
        substringContainment,
        tokenRecall,
        tokenF1,
        fullTokenCoverage,
        goldTokenCount: goldTokens.length,
        answerTokenCount: answerTokens.length,
        abstained,
        falseAbstention,
        synthMs: result.synthMs ?? 0,
    };
}
```

Update `scoreLocomoResult` to include synth:

```ts
export function scoreLocomoResult(result: LocomoQuestionResult): LocomoScore {
    return {
        sampleId: result.sampleId,
        questionIndex: result.questionIndex,
        category: result.category,
        adversarial: result.adversarial,
        metrics: scoreMetrics(result),
        synthMetrics: scoreSynthMetrics(result),
    };
}
```

- [ ] **Step 3.4: Run the tests to verify green**

Run: `bun test experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 3.5: Lint, typecheck, format, commit**

```bash
bun run typecheck
bun run lint
bun run format
git add experiments/path-memory-smoketest/eval/locomo-score.ts \
        experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts
git commit -m "feat(path-memory): Phase 8.0 — LOCOMO synth metric bundle"
```

---

## Task 4: Add synth-aware category + overall aggregators

**Files:**
- Modify: `experiments/path-memory-smoketest/eval/locomo-score.ts`
- Test: `experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts` (extend)

- [ ] **Step 4.1: Append failing aggregator tests**

Append to `experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts`:

```ts
import { aggregateLocomoOverall, aggregateLocomoByCategory } from "../eval/locomo-score.js";

describe("aggregateLocomoOverall — synth fields", () => {
    test("synth aggregates computed when at least one score has synthMetrics", () => {
        const scores = [
            scoreLocomoResult(
                base({
                    questionIndex: 0,
                    goldAnswer: "Boston",
                    retrievedClaimTexts: ["Alice moved to Boston."],
                    synthesizedAnswer: "Boston",
                    synthAbstained: false,
                    synthMs: 5,
                }),
            ),
            scoreLocomoResult(
                base({
                    questionIndex: 1,
                    goldAnswer: "Paris",
                    retrievedClaimTexts: ["She lives abroad."],
                    synthesizedAnswer: "Not mentioned",
                    synthAbstained: true,
                    synthMs: 4,
                }),
            ),
        ];
        const agg = aggregateLocomoOverall(scores);
        expect(agg.synthScoredCount).toBe(2);
        expect(agg.synthSubstringContainmentRate).toBeCloseTo(0.5, 5);
        expect(agg.falseAbstentionCount).toBe(1);
        expect(agg.abstentionCount).toBe(1);
        expect(agg.synthMeanMs).toBeCloseTo(4.5, 5);
    });

    test("synth aggregates absent when no score has synthMetrics", () => {
        const scores = [scoreLocomoResult(base({}))];
        const agg = aggregateLocomoOverall(scores);
        expect(agg.synthScoredCount).toBe(0);
        expect(agg.synthSubstringContainmentRate).toBe(0);
        expect(agg.falseAbstentionCount).toBe(0);
    });

    test("adversarial abstention counted in abstentionCount but not falseAbstention", () => {
        const scores = [
            scoreLocomoResult(
                base({
                    adversarial: true,
                    evidenceDiaIds: [],
                    synthesizedAnswer: "Not mentioned",
                    synthAbstained: true,
                    synthMs: 3,
                }),
            ),
        ];
        const agg = aggregateLocomoOverall(scores);
        expect(agg.abstentionCount).toBe(1);
        expect(agg.falseAbstentionCount).toBe(0);
    });
});

describe("aggregateLocomoByCategory — synth fields", () => {
    test("per-category synth containment rate is computed across answerables", () => {
        const scores = [
            scoreLocomoResult(
                base({
                    category: "cat-A",
                    questionIndex: 0,
                    goldAnswer: "Boston",
                    synthesizedAnswer: "Boston",
                    synthAbstained: false,
                    synthMs: 1,
                }),
            ),
            scoreLocomoResult(
                base({
                    category: "cat-A",
                    questionIndex: 1,
                    goldAnswer: "Paris",
                    synthesizedAnswer: "London",
                    synthAbstained: false,
                    synthMs: 1,
                }),
            ),
        ];
        const aggs = aggregateLocomoByCategory(scores);
        const catA = aggs.find((a) => a.category === "cat-A");
        expect(catA).toBeDefined();
        expect(catA!.synthScoredCount).toBe(2);
        expect(catA!.synthSubstringContainmentRate).toBeCloseTo(0.5, 5);
    });
});
```

- [ ] **Step 4.2: Run to verify failure**

Run: `bun test experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts`
Expected: FAIL — the new fields don't exist on `LocomoOverallAggregate` / `LocomoCategoryAggregate`.

- [ ] **Step 4.3: Extend the aggregate types and functions**

In `experiments/path-memory-smoketest/eval/locomo-score.ts`, extend `LocomoCategoryAggregate`:

```ts
export type LocomoCategoryAggregate = {
    // ...existing fields unchanged...
    meanEvidenceRecall: number;
    // Phase 8.0 — populated only when synth metrics are present.
    synthScoredCount: number;
    synthSubstringContainmentRate: number;
    synthMeanTokenRecall: number;
    synthMeanTokenF1: number;
    abstentionCount: number;
    falseAbstentionCount: number;
    synthMeanMs: number;
};
```

In `aggregateLocomoByCategory`, add synth accumulators inside the per-category loop. Only the **answerable** (non-adversarial) entries contribute to `synthSubstring/TokenRecall/TokenF1`. Abstention is counted across all entries; false-abstention across answerables only. Replace the current per-category `for (const s of entries)` block:

```ts
let synthScoredCount = 0;
let synthContainHits = 0;
let synthRecallSum = 0;
let synthF1Sum = 0;
let synthMsSum = 0;
let synthMsCount = 0;
let abstentionCount = 0;
let falseAbstentionCount = 0;

for (const s of entries) {
    // ...existing adversarial/contain/recall/f1/rank/evidence logic unchanged...

    if (s.synthMetrics !== undefined) {
        if (s.synthMetrics.abstained) abstentionCount += 1;
        if (s.synthMetrics.falseAbstention) falseAbstentionCount += 1;
        synthMsSum += s.synthMetrics.synthMs;
        synthMsCount += 1;
        if (!s.adversarial) {
            synthScoredCount += 1;
            if (s.synthMetrics.substringContainment) synthContainHits += 1;
            synthRecallSum += s.synthMetrics.tokenRecall;
            synthF1Sum += s.synthMetrics.tokenF1;
        }
    }
}
```

And when pushing the aggregate:

```ts
out.push({
    // ...existing fields...
    synthScoredCount,
    synthSubstringContainmentRate: synthScoredCount > 0 ? synthContainHits / synthScoredCount : 0,
    synthMeanTokenRecall: synthScoredCount > 0 ? synthRecallSum / synthScoredCount : 0,
    synthMeanTokenF1: synthScoredCount > 0 ? synthF1Sum / synthScoredCount : 0,
    abstentionCount,
    falseAbstentionCount,
    synthMeanMs: synthMsCount > 0 ? synthMsSum / synthMsCount : 0,
});
```

Extend `LocomoOverallAggregate` and `aggregateLocomoOverall` with the same six synth fields following the same logic (answerable-only for contain/recall/F1, all entries for abstention/ms).

- [ ] **Step 4.4: Run the tests**

Run: `bun test experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts`
Expected: PASS, 8 tests total (5 from Task 3, 3 from Task 4 aggregators… plus the category one = 4 from this task = 9 total).

- [ ] **Step 4.5: Lint, typecheck, format, commit**

```bash
bun run typecheck
bun run lint
bun run format
git add experiments/path-memory-smoketest/eval/locomo-score.ts \
        experiments/path-memory-smoketest/tests/locomo-score-synth.test.ts
git commit -m "feat(path-memory): Phase 8.0 — LOCOMO aggregators include synth"
```

---

## Task 5: Primary runner — `phase-8-0-locomo-synth.ts`

**Files:**
- Create: `experiments/path-memory-smoketest/scripts/phase-8-0-locomo-synth.ts`

- [ ] **Step 5.1: Draft the runner**

Create `experiments/path-memory-smoketest/scripts/phase-8-0-locomo-synth.ts`:

```ts
/**
 * Phase 8.0 — LOCOMO + local-LLM answer-synthesis run.
 *
 * Precondition: Ollama is running locally and the chosen model has been
 * pulled. Start with:
 *   ollama serve &
 *   ollama pull qwen2.5:1.5b-instruct
 *
 * Usage:
 *   bun scripts/phase-8-0-locomo-synth.ts [path] [--limit N] [--category NAME] [--model NAME]
 *
 * Defaults:
 *   path     ./data/locomo.json
 *   model    qwen2.5:1.5b-instruct
 *   output   ./data/phase-8-0-locomo-synth-output.json
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder } from "../src/embedder.js";
import { loadLocomo } from "../data/locomo-loader.js";
import {
    flattenQuestionResults,
    runLocomo,
    type LocomoConversationResult,
    type LocomoQuestionResult,
} from "../eval/locomo-adapter.js";
import {
    aggregateLocomoByCategory,
    aggregateLocomoOverall,
    scoreLocomo,
    type LocomoScore,
} from "../eval/locomo-score.js";
import { OllamaSynthesizer } from "../src/llm-synthesizer.js";
import type { RetrievalOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, "../data/locomo.json");
const DEFAULT_OUT = resolve(here, "../data/phase-8-0-locomo-synth-output.json");
const DEFAULT_MODEL = "qwen2.5:1.5b-instruct";

const RETRIEVAL_OPTIONS: RetrievalOptions = {
    traversal: "dijkstra",
    temporalHopCost: 0.5,
    probeComposition: "weighted-fusion",
    weightedFusionTau: 0.2,
    anchorTopK: 5,
    resultTopN: 10,
    sessionDecayTau: 0.2,
    accessTracking: false,
};

type Args = {
    datasetPath: string;
    limit?: number;
    category?: string;
    model: string;
};

function parseArgs(argv: string[]): Args {
    let datasetPath = DEFAULT_PATH;
    let limit: number | undefined;
    let category: string | undefined;
    let model = DEFAULT_MODEL;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--limit") {
            const next = argv[i + 1];
            if (!next) throw new Error("--limit requires a value");
            const parsed = Number.parseInt(next, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error(`--limit must be a positive integer, got "${next}"`);
            }
            limit = parsed;
            i++;
        } else if (a === "--category") {
            const next = argv[i + 1];
            if (!next) throw new Error("--category requires a value");
            category = next;
            i++;
        } else if (a === "--model") {
            const next = argv[i + 1];
            if (!next) throw new Error("--model requires a value");
            model = next;
            i++;
        } else if (!a.startsWith("-")) {
            datasetPath = resolve(a);
        } else {
            throw new Error(`Unknown flag: ${a}`);
        }
    }
    return { datasetPath, limit, category, model };
}

function formatMs(ms: number): string {
    return `${ms.toFixed(1)}ms`;
}

function summarizeScores(scores: LocomoScore[]): void {
    const overall = aggregateLocomoOverall(scores);
    console.log(
        `# retrieval overall:  n=${overall.count}  scored=${overall.scoredCount}  contain=${(overall.substringContainmentRate * 100).toFixed(1)}%  F1=${overall.meanTokenF1.toFixed(3)}  evidR=${overall.meanEvidenceRecall.toFixed(3)}`,
    );
    console.log(
        `# synth overall:      synthScored=${overall.synthScoredCount}  contain=${(overall.synthSubstringContainmentRate * 100).toFixed(1)}%  F1=${overall.synthMeanTokenF1.toFixed(3)}  abstain=${overall.abstentionCount}  falseAbstain=${overall.falseAbstentionCount}  meanMs=${overall.synthMeanMs.toFixed(1)}`,
    );
    const delta = overall.synthSubstringContainmentRate - overall.substringContainmentRate;
    console.log(`# Δ contain (synth − retrieval): ${(delta * 100).toFixed(2)}pp`);
    console.log();
    console.log(
        "category                       | n   | rContain | sContain |  Δ pp  | sF1   | abstain | falseAbs | msMean",
    );
    console.log("-".repeat(120));
    for (const agg of aggregateLocomoByCategory(scores)) {
        const d = (agg.synthSubstringContainmentRate - agg.substringContainmentRate) * 100;
        console.log(
            [
                agg.category.slice(0, 30).padEnd(30),
                String(agg.count).padStart(3),
                (agg.substringContainmentRate * 100).toFixed(1).padStart(7) + "%",
                (agg.synthSubstringContainmentRate * 100).toFixed(1).padStart(7) + "%",
                (d >= 0 ? "+" : "") + d.toFixed(2).padStart(5),
                agg.synthMeanTokenF1.toFixed(3).padStart(5),
                String(agg.abstentionCount).padStart(7),
                String(agg.falseAbstentionCount).padStart(8),
                agg.synthMeanMs.toFixed(1).padStart(6),
            ].join(" | "),
        );
    }
}

function buildOutput(questions: LocomoQuestionResult[], scores: LocomoScore[]): unknown {
    const scoreById = new Map(scores.map((s) => [`${s.sampleId}::${s.questionIndex}`, s]));
    return questions.map((q) => {
        const key = `${q.sampleId}::${q.questionIndex}`;
        const score = scoreById.get(key);
        return {
            sampleId: q.sampleId,
            questionIndex: q.questionIndex,
            category: q.category,
            adversarial: q.adversarial,
            questionText: q.questionText,
            goldAnswer: q.goldAnswer,
            evidenceDiaIds: q.evidenceDiaIds,
            retrievedClaimIds: q.retrievedClaimIds,
            retrievedClaimTexts: q.retrievedClaimTexts,
            retrievedDiaIds: q.retrievedDiaIds,
            topPathCount: q.topPaths.length,
            retrieveMs: q.retrieveMs,
            synthesizedAnswer: q.synthesizedAnswer,
            synthAbstained: q.synthAbstained,
            synthMs: q.synthMs,
            metrics: score?.metrics ?? null,
            synthMetrics: score?.synthMetrics ?? null,
        };
    });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!existsSync(args.datasetPath)) {
        console.log(`# Phase 8.0 LOCOMO synth run`);
        console.log(`# Dataset not found at: ${args.datasetPath}`);
        console.log(`# Download LOCOMO and place JSON at that path. Exiting 0 for CI.`);
        return;
    }

    const all = loadLocomo(args.datasetPath);
    let selected = all;
    if (args.category !== undefined) {
        selected = all
            .map((c) => ({ ...c, qa: c.qa.filter((q) => q.category === args.category) }))
            .filter((c) => c.qa.length > 0);
    }
    if (args.limit !== undefined) selected = selected.slice(0, args.limit);

    const totalQuestions = selected.reduce((acc, c) => acc + c.qa.length, 0);

    console.log(`# Phase 8.0 LOCOMO synth run`);
    console.log(`#   dataset            ${args.datasetPath}`);
    console.log(`#   model              ${args.model}`);
    console.log(`#   selected conv      ${selected.length}`);
    console.log(`#   selected questions ${totalQuestions}`);
    console.log();

    if (selected.length === 0) {
        console.log("# No conversations after filtering; nothing to do.");
        return;
    }

    const synthesizer = new OllamaSynthesizer({ model: args.model });
    await synthesizer.healthCheck();

    const embedder = await getEmbedder();
    const started = performance.now();
    const convResults: LocomoConversationResult[] = await runLocomo(selected, {
        embedder,
        retrievalOptions: RETRIEVAL_OPTIONS,
        synthesizer,
    });
    const totalMs = performance.now() - started;

    const questions = flattenQuestionResults(convResults);
    console.log(
        `# total wall-clock: ${formatMs(totalMs)}  (${(totalMs / Math.max(1, questions.length)).toFixed(1)}ms / question)`,
    );

    const scores = scoreLocomo(questions);
    console.log();
    summarizeScores(scores);

    writeFileSync(DEFAULT_OUT, JSON.stringify(buildOutput(questions, scores), null, 2), "utf8");
    console.log();
    console.log(`# wrote ${DEFAULT_OUT}`);
}

await main();
```

- [ ] **Step 5.2: Dry-run the runner with --limit 1 to verify wiring**

Precondition: `ollama serve` is running and `qwen2.5:1.5b-instruct` is pulled.

Run: `cd experiments/path-memory-smoketest && bun scripts/phase-8-0-locomo-synth.ts --limit 1`

Expected: prints retrieval + synth overall lines and a per-category table for the single conversation, writes `data/phase-8-0-locomo-synth-output.json`, exits 0. If Ollama is not up, expect an explicit health-check error — do not silently fall back.

- [ ] **Step 5.3: Lint, typecheck, format, commit**

```bash
bun run typecheck
bun run lint
bun run format
git add experiments/path-memory-smoketest/scripts/phase-8-0-locomo-synth.ts
git commit -m "feat(path-memory): Phase 8.0 — LOCOMO synth runner script"
```

---

## Task 6: Confounder runner — 150-probe 3B slice

**Files:**
- Create: `experiments/path-memory-smoketest/scripts/phase-8-0-confounder.ts`

- [ ] **Step 6.1: Draft the confounder runner**

Create `experiments/path-memory-smoketest/scripts/phase-8-0-confounder.ts`:

```ts
/**
 * Phase 8.0 confounder — run 3B model on a 150-probe LOCOMO slice.
 *
 * Purpose: rule out "model was too small" if the 1.5B primary shows no
 * lift. Stratifies 150 questions proportionally across categories, runs
 * them through the same synth pipeline with qwen2.5:3b-instruct, and
 * prints retrieval + synth contain side-by-side.
 *
 * Usage:
 *   bun scripts/phase-8-0-confounder.ts [path] [--model NAME] [--size N]
 *
 * Defaults:
 *   model  qwen2.5:3b-instruct
 *   size   150
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbedder } from "../src/embedder.js";
import { loadLocomo, type LocomoConversation, type LocomoQA } from "../data/locomo-loader.js";
import {
    flattenQuestionResults,
    runLocomo,
    type LocomoQuestionResult,
} from "../eval/locomo-adapter.js";
import {
    aggregateLocomoOverall,
    aggregateLocomoByCategory,
    scoreLocomo,
} from "../eval/locomo-score.js";
import { OllamaSynthesizer } from "../src/llm-synthesizer.js";
import type { RetrievalOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, "../data/locomo.json");
const DEFAULT_OUT = resolve(here, "../data/phase-8-0-confounder-output.json");
const DEFAULT_MODEL = "qwen2.5:3b-instruct";
const DEFAULT_SIZE = 150;

const RETRIEVAL_OPTIONS: RetrievalOptions = {
    traversal: "dijkstra",
    temporalHopCost: 0.5,
    probeComposition: "weighted-fusion",
    weightedFusionTau: 0.2,
    anchorTopK: 5,
    resultTopN: 10,
    sessionDecayTau: 0.2,
    accessTracking: false,
};

type Args = { datasetPath: string; model: string; size: number };

function parseArgs(argv: string[]): Args {
    let datasetPath = DEFAULT_PATH;
    let model = DEFAULT_MODEL;
    let size = DEFAULT_SIZE;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--model") {
            model = argv[++i];
            if (model === undefined) throw new Error("--model requires a value");
        } else if (a === "--size") {
            const next = argv[++i];
            if (!next) throw new Error("--size requires a value");
            const parsed = Number.parseInt(next, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error(`--size must be positive, got "${next}"`);
            }
            size = parsed;
        } else if (!a.startsWith("-")) {
            datasetPath = resolve(a);
        } else {
            throw new Error(`Unknown flag: ${a}`);
        }
    }
    return { datasetPath, model, size };
}

// Stratified proportional sampling across category. Deterministic:
// for reproducibility we take the first N questions per category in
// whatever order `loadLocomo` returns them.
function stratifiedSlice(
    conversations: LocomoConversation[],
    size: number,
): LocomoConversation[] {
    type Entry = { conv: LocomoConversation; qa: LocomoQA };
    const byCategory = new Map<string, Entry[]>();
    let total = 0;
    for (const conv of conversations) {
        for (const qa of conv.qa) {
            const list = byCategory.get(qa.category) ?? [];
            list.push({ conv, qa });
            byCategory.set(qa.category, list);
            total += 1;
        }
    }
    if (total === 0) return [];

    const picked = new Map<string, Set<LocomoQA>>();
    for (const [cat, entries] of byCategory) {
        const share = Math.max(1, Math.round((entries.length / total) * size));
        picked.set(cat, new Set(entries.slice(0, share).map((e) => e.qa)));
    }

    return conversations
        .map((conv) => ({
            ...conv,
            qa: conv.qa.filter((qa) => picked.get(qa.category)?.has(qa) === true),
        }))
        .filter((conv) => conv.qa.length > 0);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(args.datasetPath)) {
        console.log(`# Dataset missing at ${args.datasetPath}; exiting 0.`);
        return;
    }

    const all = loadLocomo(args.datasetPath);
    const sliced = stratifiedSlice(all, args.size);
    const totalQuestions = sliced.reduce((acc, c) => acc + c.qa.length, 0);

    console.log(`# Phase 8.0 confounder run`);
    console.log(`#   model              ${args.model}`);
    console.log(`#   requested size     ${args.size}`);
    console.log(`#   actual questions   ${totalQuestions}`);
    console.log();

    const synthesizer = new OllamaSynthesizer({ model: args.model });
    await synthesizer.healthCheck();

    const embedder = await getEmbedder();
    const convResults = await runLocomo(sliced, {
        embedder,
        retrievalOptions: RETRIEVAL_OPTIONS,
        synthesizer,
    });
    const questions: LocomoQuestionResult[] = flattenQuestionResults(convResults);
    const scores = scoreLocomo(questions);
    const overall = aggregateLocomoOverall(scores);

    console.log(
        `# retrieval contain: ${(overall.substringContainmentRate * 100).toFixed(1)}%`,
    );
    console.log(
        `# synth contain:     ${(overall.synthSubstringContainmentRate * 100).toFixed(1)}%`,
    );
    console.log(
        `# Δ contain:         ${((overall.synthSubstringContainmentRate - overall.substringContainmentRate) * 100).toFixed(2)}pp`,
    );
    console.log(
        `# false abstain:     ${overall.falseAbstentionCount}/${overall.synthScoredCount}`,
    );

    console.log();
    console.log("# per-category:");
    console.log("category                       | n   | Δ contain (pp) | falseAbs");
    console.log("-".repeat(80));
    for (const agg of aggregateLocomoByCategory(scores)) {
        const d = (agg.synthSubstringContainmentRate - agg.substringContainmentRate) * 100;
        console.log(
            [
                agg.category.slice(0, 30).padEnd(30),
                String(agg.count).padStart(3),
                (d >= 0 ? "+" : "") + d.toFixed(2).padStart(6),
                String(agg.falseAbstentionCount).padStart(8),
            ].join(" | "),
        );
    }

    writeFileSync(
        DEFAULT_OUT,
        JSON.stringify({ model: args.model, overall, questions }, null, 2),
        "utf8",
    );
    console.log();
    console.log(`# wrote ${DEFAULT_OUT}`);
}

await main();
```

- [ ] **Step 6.2: Dry-run with --size 5 to verify wiring**

Precondition: `ollama pull qwen2.5:3b-instruct` has been run.

Run: `cd experiments/path-memory-smoketest && bun scripts/phase-8-0-confounder.ts --size 5`

Expected: prints overall + per-category blocks and writes `data/phase-8-0-confounder-output.json`.

- [ ] **Step 6.3: Lint, typecheck, format, commit**

```bash
bun run typecheck
bun run lint
bun run format
git add experiments/path-memory-smoketest/scripts/phase-8-0-confounder.ts
git commit -m "feat(path-memory): Phase 8.0 — confounder runner (3B 150-slice)"
```

---

## Task 7: Run the evaluation end-to-end and write up

**Files:**
- Create: `experiments/path-memory-smoketest/notes/phase-8-0-reading.md`
- Modify: `/Users/kuindji/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/MEMORY.md`
- Create: `/Users/kuindji/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/path_memory_phase80.md`

- [ ] **Step 7.1: Full LOCOMO primary run at 1.5B**

Precondition: Ollama up, `qwen2.5:1.5b-instruct` pulled.

Run: `cd experiments/path-memory-smoketest && bun scripts/phase-8-0-locomo-synth.ts | tee data/phase-8-0-locomo-synth-log.txt`

Expected: console output with retrieval + synth overall and per-category tables; `data/phase-8-0-locomo-synth-output.json` written. Capture: retrieval contain, synth contain, Δ, falseAbstention count, meanMs, total wall-clock.

- [ ] **Step 7.2: MSC non-regression check**

Run: `cd experiments/path-memory-smoketest && bun scripts/phase-7.5-msc-dryrun.ts | tee data/phase-8-0-msc-regression.txt`

Expected: the same retrieval numbers the Phase 7.5 reading reports, within noise. No synthesizer involved; this is a retrieval-only sanity run to confirm nothing drifted underneath us. Compare persona recall to the 0.332 baseline — a drop > 0.02 means **stop** and investigate before running the confounder.

- [ ] **Step 7.3: LongMemEval non-regression check**

Run: `cd experiments/path-memory-smoketest && bun scripts/phase-7-longmemeval-dryrun.ts | tee data/phase-8-0-longmemeval-regression.txt`

Expected: retrieval-only numbers; compare contain against the latest Phase 7 reading. A drop > 0.03 means **stop**.

- [ ] **Step 7.4: Confounder run at 3B**

Precondition: `qwen2.5:3b-instruct` pulled.

Run: `cd experiments/path-memory-smoketest && bun scripts/phase-8-0-confounder.ts | tee data/phase-8-0-confounder-log.txt`

Expected: 150-ish probe results with overall Δ and per-category Δ.

- [ ] **Step 7.5: Author the reading**

Create `experiments/path-memory-smoketest/notes/phase-8-0-reading.md` with sections:

1. **Config.** Retrieval options (verbatim from the runner), synth prompt, models, dataset paths.
2. **Primary results.** Overall retrieval contain, synth contain, Δ, falseAbstention / abstention counts, mean synthMs, wall-clock. Per-category table.
3. **Non-regression gates.** MSC persona recall before vs after; LongMemEval contain before vs after. Pass / fail.
4. **Confounder.** 1.5B vs 3B Δ on the 150-slice. Decision rule applied (escalate to 3B, keep 1.5B, or phase PARK).
5. **Verdict.** SHIP default-on / SHIP opt-in / PARK, citing the gates in the spec.
6. **Next step.** Explicitly name what comes after — Phase 8.1 (query rewriting), 8.2 (re-ranking), 8.3 (ingestion-side extraction) per the spec's out-of-scope list, OR continued tuning on the synthesizer if the confounder flagged something.

- [ ] **Step 7.6: Write the memory entries**

Create `/Users/kuindji/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/path_memory_phase80.md` with frontmatter:

```markdown
---
name: Path-memory Phase 8.0 — local-LLM answer-synthesis
description: [one-line outcome, e.g. "SHIP opt-in: synth contain +Xpp over retrieval on LOCOMO; MSC/LongMemEval non-regressed"]
type: project
---

[Body with: models used, Δ numbers, gate verdict, confounder outcome, next phase pointer.]

**Why:** [why this phase was run — cite the evidR/contain gap]

**How to apply:** [what downstream phases should do with this result]
```

Then add one line to `MEMORY.md` in the path-memory section, same ~150-char shape as the existing entries.

- [ ] **Step 7.7: Commit results + writeup + memory**

```bash
bun run format
git add experiments/path-memory-smoketest/notes/phase-8-0-reading.md \
        experiments/path-memory-smoketest/data/phase-8-0-locomo-synth-output.json \
        experiments/path-memory-smoketest/data/phase-8-0-confounder-output.json \
        experiments/path-memory-smoketest/data/phase-8-0-locomo-synth-log.txt \
        experiments/path-memory-smoketest/data/phase-8-0-msc-regression.txt \
        experiments/path-memory-smoketest/data/phase-8-0-longmemeval-regression.txt \
        experiments/path-memory-smoketest/data/phase-8-0-confounder-log.txt
git commit -m "feat(path-memory): Phase 8.0 — LOCOMO synth reading + artefacts"

git add /Users/kuindji/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/path_memory_phase80.md \
        /Users/kuindji/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/MEMORY.md
# note: memory/ lives outside the repo; skip this git add if it isn't tracked here.
```

(If memory/ is outside the repo, just save the files — no commit needed for that step.)

---

## Notes for the engineer

- **Do not touch retrieval options.** The whole point is to isolate the synthesizer's contribution. If a step tempts you to sweep `resultTopN`, `anchorTopK`, or decay parameters, that's a different phase (Phase 7.6 precision tuning).
- **Do not add few-shot examples to the prompt in v0.** The spec locks this as zero-shot so we see headroom before complicating things.
- **If Ollama health check fails**, do not fall back to any mock or alternative provider. Fail fast and surface the error to the operator — silent fallback would contaminate the numbers.
- **Prefer reading existing adapters before writing new ones.** `eval/longmemeval-score.ts`, `eval/msc-score.ts`, and the existing `eval/locomo-score.ts` show the rule-based metric pattern that `synth.*` now mirrors.
- **Test names matter.** `describe` blocks should reference the function under test; the existing style uses `functionName — behavior`. Follow it.
