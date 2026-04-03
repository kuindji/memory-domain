# KB Context Noise Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce KB context noise from ~90% to <20% while maintaining answer quality >4.5/5 through three layered approaches: tightened filters (A), embedding re-ranking (C), and LLM re-ranking (B).

**Architecture:** Three independent approaches, each togglable. Approach A modifies thresholds and removes a noise-generating fallback in the search engine. Approach C adds a second-pass embedding similarity check on search results. Approach B adds LLM-based semantic relevance scoring. The testing loop runs each combination (A, C, A+C, A+B, C+B, A+B+C) and stops when noise <20% and quality >4.5/5.

**Tech Stack:** TypeScript, SurrealDB (cosine similarity), ONNX embeddings, Claude CLI (haiku), bun

---

## File Structure

### Approach A (tighten filters)
- Modify: `src/core/search-engine.ts` — remove recency fallback, reduce default limit
- Modify: `src/domains/kb/kb-domain.ts` — raise minScore default, hard topic filter

### Approach C (embedding re-rank)
- Modify: `src/core/search-engine.ts` — add `rerankByEmbedding()` method
- Modify: `src/core/types.ts` — add `rerank`, `rerankThreshold` to SearchQuery
- Modify: `src/domains/kb/kb-domain.ts` — pass rerank option in buildContext searches

### Approach B (LLM re-rank)
- Modify: `src/domains/kb/kb-domain.ts` — add LLM re-ranking step in buildContext

### Testing infrastructure
- Modify: `tests-integration/kb-architecture/types.ts` — add `noiseReduction` to ArchitectureConfig
- Modify: `tests-integration/kb-architecture/configs.ts` — add 6 noise reduction configs
- Modify: `tests-integration/kb-architecture/engine-factory.ts` — wire noise reduction options

### Tests
- Test: `tests/search-engine.test.ts` — test recency fallback removal, reduced limits
- Test: `tests/build-context.test.ts` — test hard topic filter, embedding rerank, LLM rerank

---

## Task 1: Remove Graph Recency Fallback

**Files:**
- Modify: `src/core/search-engine.ts:296-321`
- Test: `tests/search-engine.test.ts`

The graph search fallback returns 20 most recent memories at score 0.5 when there are no tags and no traversal. These are pure noise — unrelated to the query.

- [ ] **Step 1: Write failing test for recency fallback removal**

In `tests/search-engine.test.ts`, find or create a test that verifies graph search returns empty when no tags/traversal match:

```typescript
test("graph search returns empty when no tags or traversal provided", async () => {
    // Ingest some memories first
    await engine.ingest("Memory about Byzantine history", { domains: ["kb"] });
    await engine.ingest("Memory about Roman roads", { domains: ["kb"] });
    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }

    // Search with graph mode only, no tags, no traversal
    const result = await engine.search({
        text: "quantum physics",
        mode: "graph",
        domains: ["kb"],
    });

    // Should return nothing — no tags match, no traversal
    expect(result.entries.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/search-engine.test.ts -t "graph search returns empty"`
Expected: FAIL — currently returns 2 memories at score 0.5

- [ ] **Step 3: Remove recency fallback**

In `src/core/search-engine.ts`, replace the recency fallback block (lines 296-321) with an empty return:

```typescript
        // No tags, no traversal — return empty (no recency fallback)
        return candidates;
    }
```

The full method should end like this after the tag-based search block (line 293):

```typescript
            return candidates;
        }

        // No tags, no traversal — return empty (no recency fallback)
        return candidates;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/search-engine.test.ts -t "graph search returns empty"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All pass. If any test relied on recency fallback behavior, it will need updating.

- [ ] **Step 6: Commit**

```bash
bun format
git add src/core/search-engine.ts tests/search-engine.test.ts
git commit -m "Remove graph search recency fallback that injected noise at score 0.5"
```

---

## Task 2: Reduce Default Search Limit and Raise minScore

**Files:**
- Modify: `src/core/search-engine.ts:42,144,181,272,299`
- Modify: `src/domains/kb/kb-domain.ts:108`

- [ ] **Step 1: Reduce default search limit from 20 to 10**

In `src/core/search-engine.ts`, change the default limit in the `search()` method (line 42):

```typescript
        const limit = query.limit ?? 10;
```

Also change default limits in each individual search method where `query.limit ?? 20` appears:

In `vectorSearch` (line 144):
```typescript
            { queryVec, limit: query.limit ?? 10 },
```

In `fulltextSearch` (line 181 area — find the LIMIT line):
```typescript
                { text: query.text, limit: query.limit ?? 10 },
```

In `graphSearch` tag-based search (line 272):
```typescript
                { tags: tagRecordIds, limit: query.limit ?? 10 },
```

- [ ] **Step 2: Raise minScore default from 0.3 to 0.5**

In `src/domains/kb/kb-domain.ts`, change the tunableParams definition (line 108):

```typescript
            { name: "minScore", default: 0.5, min: 0.15, max: 0.8, step: 0.05 },
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All pass. Some tests may need minScore adjustments if they relied on 0.3 threshold.

- [ ] **Step 4: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
bun format
git add src/core/search-engine.ts src/domains/kb/kb-domain.ts
git commit -m "Reduce search limit to 10, raise minScore default to 0.5"
```

---

## Task 3: Hard Topic Filter

**Files:**
- Modify: `src/domains/kb/kb-domain.ts:291-306`
- Test: `tests/build-context.test.ts`

When topics are identified for a query, non-topic memories should be dropped entirely (not just penalized). Fallback: if dropping would leave zero memories, keep the single best non-topic memory.

- [ ] **Step 1: Write failing test for hard topic filter**

In `tests/build-context.test.ts`:

```typescript
test("buildContext drops non-topic memories when topics are found", async () => {
    // Ingest entries about two distinct topics
    await engine.ingest("Silk production was a state monopoly in Byzantium, managed by imperial workshops", {
        domains: ["kb"],
    });
    await engine.ingest("Greek fire was a secret incendiary weapon used by the Byzantine navy in naval warfare", {
        domains: ["kb"],
    });
    await engine.ingest("The bezant gold coin was the standard currency of the Byzantine economy for centuries", {
        domains: ["kb"],
    });

    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }

    const result = await engine.buildContext("Tell me about Byzantine silk production and trade", {
        domains: ["kb"],
        budgetTokens: 2000,
    });

    // All returned memories should be related to silk/trade, not greek fire
    const hasGreekFire = result.memories.some((m) =>
        m.content.toLowerCase().includes("greek fire"),
    );
    expect(hasGreekFire).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/build-context.test.ts -t "drops non-topic"`
Expected: FAIL — currently greek fire is penalized but not removed

- [ ] **Step 3: Convert applyTopicBoost to hard filter**

In `src/domains/kb/kb-domain.ts`, replace the `applyTopicBoost` function (lines 291-306):

```typescript
function applyTopicFilter(
    memories: ScoredMemory[],
    topicMemoryIds: Set<string>,
    boostFactor: number,
): ScoredMemory[] {
    const topicMatches = memories.filter((m) => topicMemoryIds.has(m.id));
    const nonTopicMatches = memories.filter((m) => !topicMemoryIds.has(m.id));

    // Boost topic-matching memories
    const boosted = topicMatches.map((m) => ({ ...m, score: m.score * boostFactor }));

    // If filtering would leave nothing, keep the single best non-topic memory
    if (boosted.length === 0 && nonTopicMatches.length > 0) {
        return [nonTopicMatches[0]];
    }

    boosted.sort((a, b) => b.score - a.score);
    return boosted;
}
```

- [ ] **Step 4: Update all call sites from applyTopicBoost to applyTopicFilter**

In `buildContext`, section 1 (around line 196-198), replace:

```typescript
            if (hasTopicFilter) {
                applyTopicBoost(allMemories, topicMemoryIds, topicBoost, topicPenalty);
            }

            const definitionMemories = deduplicateMemories(allMemories);
```

with:

```typescript
            let filteredAll = allMemories;
            if (hasTopicFilter) {
                filteredAll = applyTopicFilter(allMemories, topicMemoryIds, topicBoost);
            }

            const definitionMemories = deduplicateMemories(filteredAll);
```

In section 2 (around line 222-224), replace:

```typescript
                if (hasTopicFilter) {
                    applyTopicBoost(entries, topicMemoryIds, topicBoost, topicPenalty);
                }
                allMemories.push(...entries);
```

with:

```typescript
                let filteredEntries = entries;
                if (hasTopicFilter) {
                    filteredEntries = applyTopicFilter(entries, topicMemoryIds, topicBoost);
                }
                allMemories.push(...filteredEntries);
```

In section 3 (around line 254-256), apply the same pattern:

```typescript
                let filteredEntries = entries;
                if (hasTopicFilter) {
                    filteredEntries = applyTopicFilter(entries, topicMemoryIds, topicBoost);
                }
```

Then use `filteredEntries` instead of `entries` for truncation and pushing to `allMemories`.

- [ ] **Step 5: Remove topicPenalty tunable param**

Since we no longer penalize (we drop), remove the `topicPenaltyFactor` tunable param from the declaration (line 112):

```typescript
        // Remove this line:
        // { name: "topicPenaltyFactor", default: 0.5, min: 0.1, max: 1.0, step: 0.1 },
```

And remove the `topicPenalty` variable in buildContext (line 166):

```typescript
        // Remove this line:
        // const topicPenalty = context.getTunableParam("topicPenaltyFactor") ?? 0.5;
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/build-context.test.ts -v`
Expected: All pass including the new test

- [ ] **Step 7: Run full suite + lint + typecheck**

Run: `bun run lint && bun run typecheck && bun test`
Expected: Clean

- [ ] **Step 8: Commit**

```bash
bun format
git add src/domains/kb/kb-domain.ts tests/build-context.test.ts
git commit -m "Replace topic penalty with hard filter: drop non-topic memories entirely"
```

---

## Task 4: Add Noise Reduction Configs and Testing Infrastructure

**Files:**
- Modify: `tests-integration/kb-architecture/types.ts:32-41`
- Modify: `tests-integration/kb-architecture/configs.ts`
- Modify: `tests-integration/kb-architecture/engine-factory.ts`

- [ ] **Step 1: Add noiseReduction to ArchitectureConfig**

In `tests-integration/kb-architecture/types.ts`, extend the interface:

```typescript
export interface ArchitectureConfig {
    name: string;
    pipeline: PipelineStages;
    search: {
        mode: "vector" | "fulltext" | "hybrid";
        weights: { vector: number; fulltext: number; graph: number };
    };
    consolidate: boolean;
    contextBudget: number;
    noiseReduction?: {
        tightenFilters?: boolean;
        embeddingRerank?: boolean;
        llmRerank?: boolean;
    };
}
```

- [ ] **Step 2: Add 6 noise reduction configs**

In `tests-integration/kb-architecture/configs.ts`, add after the existing configs:

```typescript
const NO_SUPERSESSION_PIPELINE = {
    classify: true,
    tagAssign: true,
    topicLink: true,
    supersede: false,
    relateKnowledge: false,
};

// Noise reduction testing configs — all based on best config (no-supersession-2000)
{
    name: "noise-reduce-A",
    pipeline: NO_SUPERSESSION_PIPELINE,
    search: HYBRID_DEFAULT,
    consolidate: false,
    contextBudget: 2000,
    noiseReduction: { tightenFilters: true },
},
{
    name: "noise-reduce-C",
    pipeline: NO_SUPERSESSION_PIPELINE,
    search: HYBRID_DEFAULT,
    consolidate: false,
    contextBudget: 2000,
    noiseReduction: { embeddingRerank: true },
},
{
    name: "noise-reduce-AC",
    pipeline: NO_SUPERSESSION_PIPELINE,
    search: HYBRID_DEFAULT,
    consolidate: false,
    contextBudget: 2000,
    noiseReduction: { tightenFilters: true, embeddingRerank: true },
},
{
    name: "noise-reduce-AB",
    pipeline: NO_SUPERSESSION_PIPELINE,
    search: HYBRID_DEFAULT,
    consolidate: false,
    contextBudget: 2000,
    noiseReduction: { tightenFilters: true, llmRerank: true },
},
{
    name: "noise-reduce-CB",
    pipeline: NO_SUPERSESSION_PIPELINE,
    search: HYBRID_DEFAULT,
    consolidate: false,
    contextBudget: 2000,
    noiseReduction: { embeddingRerank: true, llmRerank: true },
},
{
    name: "noise-reduce-ABC",
    pipeline: NO_SUPERSESSION_PIPELINE,
    search: HYBRID_DEFAULT,
    consolidate: false,
    contextBudget: 2000,
    noiseReduction: { tightenFilters: true, embeddingRerank: true, llmRerank: true },
},
```

- [ ] **Step 3: Wire noise reduction into engine-factory**

In `tests-integration/kb-architecture/engine-factory.ts`, the noise reduction options need to be passed through to the KB domain and search engine. Approach A changes are already in the code (Tasks 1-3 modified defaults). For configs where `tightenFilters` is false, we need to revert to old defaults.

Update `createConfiguredEngine`:

```typescript
export async function createConfiguredEngine(config: ArchitectureConfig): Promise<MemoryEngine> {
    const engine = new MemoryEngine();
    await engine.initialize({
        connection: "mem://",
        namespace: "test",
        database: `arch_${config.name}_${Date.now()}`,
        llm,
        embedding,
        search: {
            defaultMode: config.search.mode,
            defaultWeights: config.search.weights,
        },
        debug: { timing: true },
    });

    const baseDomain = createKbDomain({
        consolidateSchedule: { enabled: false },
    });

    const configurableProcessor = createConfigurableInboxProcessor(config.pipeline);

    const modifiedDomain: DomainConfig = {
        ...baseDomain,
        processInboxBatch: configurableProcessor,
    };

    // If noise reduction config doesn't include tightenFilters,
    // override tunable params to use old permissive defaults
    if (!config.noiseReduction?.tightenFilters && modifiedDomain.tunableParams) {
        modifiedDomain.tunableParams = modifiedDomain.tunableParams.map((p) => {
            if (p.name === "minScore") return { ...p, default: 0.3 };
            return p;
        });
    }

    await engine.registerDomain(modifiedDomain);
    await engine.registerDomain(topicDomain);

    return engine;
}
```

- [ ] **Step 4: Run lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
bun format
git add tests-integration/kb-architecture/types.ts tests-integration/kb-architecture/configs.ts tests-integration/kb-architecture/engine-factory.ts
git commit -m "Add noise reduction configs and wire into engine factory"
```

---

## Task 5: Run Approach A Testing

This is an execution task — run the testing loop with approach A only.

- [ ] **Step 1: Run baseline for comparison**

```bash
bun run tests-integration/kb-architecture/run.ts --baseline
```

Record the baseline score and noise.

- [ ] **Step 2: Run noise-reduce-A config**

```bash
bun run tests-integration/kb-architecture/run.ts --config noise-reduce-A
```

- [ ] **Step 3: Log results**

```bash
taskflow-cli log info "noise-reduce-A: avg <score>/5, noise <noise>%, time <time>s"
```

- [ ] **Step 4: Check stop criteria**

If noise <20% AND quality >4.5/5, stop here — no need for approaches C or B.

- [ ] **Step 5: Commit results**

```bash
git add tests-integration/kb-architecture/checkpoints/
git commit -m "Testing loop: approach A (tightened filters) results"
```

---

## Task 6: Embedding Re-ranking (Approach C)

**Files:**
- Modify: `src/core/types.ts:108-124`
- Modify: `src/core/search-engine.ts`
- Test: `tests/search-engine.test.ts`

Add a re-ranking step that computes direct cosine similarity between query embedding and each candidate's stored embedding, filtering out low-similarity candidates.

- [ ] **Step 1: Add rerank fields to SearchQuery**

In `src/core/types.ts`, add to the `SearchQuery` interface (after `context` field, line 123):

```typescript
export interface SearchQuery extends MemoryFilter {
    text?: string;
    mode?: "vector" | "fulltext" | "hybrid" | "graph";
    traversal?: {
        from: string | string[];
        pattern: string;
        depth?: number;
    };
    tokenBudget?: number;
    minScore?: number;
    weights?: {
        vector?: number;
        fulltext?: number;
        graph?: number;
    };
    context?: RequestContext;
    rerank?: boolean;
    rerankThreshold?: number;
}
```

- [ ] **Step 2: Write failing test for embedding rerank**

In `tests/search-engine.test.ts`:

```typescript
test("rerank filters candidates by direct embedding similarity", async () => {
    // Ingest diverse memories
    await engine.ingest("Silk production was a major Byzantine industry", { domains: ["kb"] });
    await engine.ingest("Greek fire was a devastating naval weapon", { domains: ["kb"] });
    await engine.ingest("The Hippodrome hosted chariot races in Constantinople", { domains: ["kb"] });

    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }

    // Search with rerank enabled — should filter to most relevant
    const result = await engine.search({
        text: "Byzantine silk trade and production",
        mode: "hybrid",
        domains: ["kb"],
        rerank: true,
        rerankThreshold: 0.5,
    });

    // Silk memory should be present; unrelated memories should be filtered
    const hasSilk = result.entries.some((e) => e.content.toLowerCase().includes("silk"));
    expect(hasSilk).toBe(true);

    // With rerank, fewer total results (noise filtered)
    // At minimum, silk should rank first
    if (result.entries.length > 0) {
        expect(result.entries[0].content.toLowerCase()).toContain("silk");
    }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/search-engine.test.ts -t "rerank filters"`
Expected: FAIL — rerank not yet implemented

- [ ] **Step 4: Add cosine similarity helper to scoring.ts**

In `src/core/scoring.ts`, add:

```typescript
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}
```

- [ ] **Step 5: Implement rerankByEmbedding in SearchEngine**

In `src/core/search-engine.ts`, add a private method after the `hybridSearch` method:

```typescript
    private async rerankByEmbedding(
        entries: ScoredMemory[],
        queryText: string,
        threshold: number,
    ): Promise<ScoredMemory[]> {
        if (!this.embeddingAdapter || entries.length === 0) return entries;

        const queryVec = await this.embeddingAdapter.embed(queryText);

        // Fetch stored embeddings for all candidate IDs
        const ids = entries.map((e) =>
            e.id.startsWith("memory:") ? new StringRecordId(e.id) : new StringRecordId(`memory:${e.id}`),
        );

        const rows = await this.store.query<Array<{ id: unknown; embedding: number[] }>>(
            `SELECT id, embedding FROM memory WHERE id IN $ids`,
            { ids },
        );

        if (!rows) return entries;

        const embeddingMap = new Map<string, number[]>();
        for (const row of rows) {
            if (row.embedding) {
                embeddingMap.set(String(row.id), row.embedding);
            }
        }

        // Score each entry by direct cosine similarity and filter
        const reranked: ScoredMemory[] = [];
        for (const entry of entries) {
            const emb = embeddingMap.get(entry.id);
            if (!emb) {
                // No embedding stored — keep with original score
                reranked.push(entry);
                continue;
            }
            const similarity = cosineSimilarity(queryVec, emb);
            if (similarity >= threshold) {
                reranked.push({ ...entry, score: similarity });
            }
        }

        reranked.sort((a, b) => b.score - a.score);
        return reranked;
    }
```

Import `cosineSimilarity` at the top of the file:

```typescript
import { countTokens, mergeScores, applyTokenBudget, cosineSimilarity } from "./scoring.js";
```

- [ ] **Step 6: Wire rerank into the search() method**

In `src/core/search-engine.ts`, in the `search()` method, after the minScore filter and sort (around line 99), before the limit application (line 102), add:

```typescript
        // Apply embedding re-ranking if requested
        if (query.rerank && query.text) {
            entries = await this.rerankByEmbedding(
                entries,
                query.text,
                query.rerankThreshold ?? 0.5,
            );
        }
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/search-engine.test.ts -v`
Expected: All pass including the new rerank test

- [ ] **Step 8: Run full suite + lint + typecheck**

Run: `bun run lint && bun run typecheck && bun test`
Expected: Clean

- [ ] **Step 9: Commit**

```bash
bun format
git add src/core/scoring.ts src/core/search-engine.ts src/core/types.ts tests/search-engine.test.ts
git commit -m "Add embedding-based re-ranking for search result precision filtering"
```

---

## Task 7: Wire Embedding Re-rank into KB buildContext

**Files:**
- Modify: `src/domains/kb/kb-domain.ts:180-260`

When approach C is active, pass `rerank: true` on each search call in buildContext.

- [ ] **Step 1: Add rerank to buildContext search calls**

In `src/domains/kb/kb-domain.ts`, in the `buildContext` function, modify each `context.search()` call to include rerank. For section 1 (line 182):

```typescript
                const result = await context.search({
                    text,
                    tags: [tag],
                    tokenBudget: definitionBudget,
                    minScore,
                    rerank: true,
                    rerankThreshold: minScore,
                });
```

Apply the same pattern to section 2 (line 211) and section 3 (line 241):

```typescript
                const result = await context.search({
                    text,
                    tags: [tag],
                    tokenBudget: factBudget,  // or howtoBudget for section 3
                    minScore,
                    rerank: true,
                    rerankThreshold: minScore,
                });
```

The `rerankThreshold` uses the same `minScore` value so it's consistent with the primary filter.

- [ ] **Step 2: Run tests**

Run: `bun test tests/build-context.test.ts -v`
Expected: All pass

- [ ] **Step 3: Run full suite + lint + typecheck**

Run: `bun run lint && bun run typecheck && bun test`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
bun format
git add src/domains/kb/kb-domain.ts
git commit -m "Wire embedding rerank into KB buildContext search calls"
```

---

## Task 8: Run Approach C and A+C Testing

- [ ] **Step 1: Run noise-reduce-C config**

```bash
bun run tests-integration/kb-architecture/run.ts --config noise-reduce-C
```

- [ ] **Step 2: Log results**

```bash
taskflow-cli log info "noise-reduce-C: avg <score>/5, noise <noise>%, time <time>s"
```

- [ ] **Step 3: Run noise-reduce-AC config**

```bash
bun run tests-integration/kb-architecture/run.ts --config noise-reduce-AC
```

- [ ] **Step 4: Log results**

```bash
taskflow-cli log info "noise-reduce-AC: avg <score>/5, noise <noise>%, time <time>s"
```

- [ ] **Step 5: Check stop criteria**

If any config achieves noise <20% AND quality >4.5/5, stop — no need for approach B.

- [ ] **Step 6: Commit results**

```bash
git add tests-integration/kb-architecture/checkpoints/
git commit -m "Testing loop: approaches C and A+C results"
```

---

## Task 9: LLM Re-ranking (Approach B)

**Files:**
- Modify: `src/domains/kb/kb-domain.ts`
- Test: `tests/build-context.test.ts`

Only implement this if approaches A and C haven't met the stop criteria.

Add an LLM-based relevance scoring step in buildContext. After all sections are collected but before token budget truncation, send all candidate memories to haiku for relevance scoring. Drop irrelevant ones.

- [ ] **Step 1: Write failing test**

In `tests/build-context.test.ts`:

```typescript
test("buildContext with LLM rerank filters irrelevant memories", async () => {
    await engine.ingest("Silk production was a state monopoly in Byzantium", {
        domains: ["kb"],
    });
    await engine.ingest("Greek fire was a secret naval weapon used by the Byzantine navy", {
        domains: ["kb"],
    });
    await engine.ingest("Modern JavaScript frameworks include React and Vue", {
        domains: ["kb"],
    });

    let hasMore = true;
    while (hasMore) {
        hasMore = await engine.processInbox();
    }

    const result = await engine.buildContext("Tell me about Byzantine military technology", {
        domains: ["kb"],
        budgetTokens: 2000,
    });

    // JavaScript memory should not appear in Byzantine military context
    const hasJS = result.memories.some((m) =>
        m.content.toLowerCase().includes("javascript"),
    );
    expect(hasJS).toBe(false);
});
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `bun test tests/build-context.test.ts -t "LLM rerank"`
Expected: May pass or fail depending on whether embedding similarity already filters JS out.

- [ ] **Step 3: Add LLM rerank function to kb-domain.ts**

Add before the `buildContext` function:

```typescript
async function llmRerankMemories(
    query: string,
    memories: ScoredMemory[],
    context: DomainContext,
): Promise<ScoredMemory[]> {
    if (memories.length === 0) return memories;

    const numbered = memories
        .map((m, i) => `[${i}] ${m.content.substring(0, 200)}`)
        .join("\n");

    const prompt = `Given the query: "${query}"

Score each memory's relevance (0-5). Only include memories scoring 3+.

Memories:
${numbered}

Respond with ONLY a JSON array of objects: [{"index": 0, "score": 5}, ...]
Include only memories with score >= 3.`;

    try {
        const response = await context.llm.generate(prompt);
        const match = response.match(/\[[\s\S]*\]/);
        if (!match) return memories;

        const scores = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
        const result: ScoredMemory[] = [];

        for (const s of scores) {
            if (s.index >= 0 && s.index < memories.length && s.score >= 3) {
                result.push({ ...memories[s.index], score: s.score / 5 });
            }
        }

        result.sort((a, b) => b.score - a.score);

        // Fallback: if LLM filtered everything, return original
        return result.length > 0 ? result : memories;
    } catch {
        return memories;
    }
}
```

- [ ] **Step 4: Wire LLM rerank into buildContext**

In `buildContext`, after all three sections are collected and before the `return` statement (around line 267), add:

```typescript
            // LLM re-rank: score all collected memories for relevance
            const allCollected = deduplicateMemories(allMemories);
            const reranked = await llmRerankMemories(text, allCollected, context);

            // Rebuild sections from reranked memories
            if (reranked.length < allCollected.length) {
                const rerankedIds = new Set(reranked.map((m) => m.id));
                sections.length = 0;

                const rerankedDefs = reranked.filter((m) =>
                    definitionMemories.some((d) => d.id === m.id),
                );
                if (rerankedDefs.length > 0) {
                    const lines = truncateToTokenBudget(rerankedDefs, definitionBudget);
                    if (lines.length > 0) {
                        sections.push(`[Definitions & Concepts]\n${lines.join("\n")}`);
                    }
                }

                const rerankedFacts = reranked.filter(
                    (m) =>
                        !rerankedDefs.some((d) => d.id === m.id) &&
                        dedupedFacts.some((f) => f.id === m.id),
                );
                if (rerankedFacts.length > 0) {
                    const lines = truncateToTokenBudget(rerankedFacts, factBudget);
                    if (lines.length > 0) {
                        sections.push(`[Facts & References]\n${lines.join("\n")}`);
                    }
                }

                const rerankedHowtos = reranked.filter(
                    (m) =>
                        !rerankedDefs.some((d) => d.id === m.id) &&
                        !rerankedFacts.some((f) => f.id === m.id),
                );
                if (rerankedHowtos.length > 0) {
                    const lines = truncateToTokenBudget(rerankedHowtos, howtoBudget);
                    if (lines.length > 0) {
                        sections.push(`[How-Tos & Insights]\n${lines.join("\n")}`);
                    }
                }

                const finalContext = sections.join("\n\n");
                const totalTokens = countTokens(finalContext);
                return {
                    context: finalContext,
                    memories: reranked,
                    totalTokens,
                };
            }
```

Note: This block goes right before the existing final `return` statement, which becomes the fallback when LLM rerank didn't reduce anything.

- [ ] **Step 5: Ensure DomainContext exposes llm**

Check that `context.llm` is available in `DomainContext`. If not, the function needs to access it differently. The LLM adapter may need to be passed through the context or imported directly.

Look at the `DomainContext` interface in `src/core/types.ts` for the `llm` field. If it's not there, use the engine's `ask()` method or import the LLM adapter.

- [ ] **Step 6: Run tests**

Run: `bun test tests/build-context.test.ts -v`
Expected: All pass

- [ ] **Step 7: Run full suite + lint + typecheck**

Run: `bun run lint && bun run typecheck && bun test`
Expected: Clean

- [ ] **Step 8: Commit**

```bash
bun format
git add src/domains/kb/kb-domain.ts tests/build-context.test.ts
git commit -m "Add LLM-based re-ranking of KB buildContext results"
```

---

## Task 10: Make Approaches Toggleable via Config

**Files:**
- Modify: `src/domains/kb/kb-domain.ts`
- Modify: `tests-integration/kb-architecture/engine-factory.ts`

The approach A changes (Tasks 1-3) are now permanent defaults. For testing configs that don't use approach A, the engine factory already overrides minScore. But approaches C and B need to be toggleable.

- [ ] **Step 1: Add embeddingRerank and llmRerank as tunable params**

In `src/domains/kb/kb-domain.ts`, add two new tunable boolean-like params (using 0/1):

```typescript
        tunableParams: [
            { name: "minScore", default: 0.5, min: 0.15, max: 0.8, step: 0.05 },
            { name: "definitionBudgetPct", default: 0.3, min: 0.1, max: 0.6, step: 0.05 },
            { name: "factBudgetPct", default: 0.4, min: 0.1, max: 0.6, step: 0.05 },
            { name: "topicBoostFactor", default: 1.5, min: 1.0, max: 3.0, step: 0.25 },
            { name: "embeddingRerank", default: 1, min: 0, max: 1, step: 1 },
            { name: "llmRerank", default: 0, min: 0, max: 1, step: 1 },
        ],
```

- [ ] **Step 2: Gate rerank and LLM rerank behind tunable params**

In buildContext, gate the embedding rerank on each search call:

```typescript
            const useEmbeddingRerank = (context.getTunableParam("embeddingRerank") ?? 1) > 0;
```

Then in each search call:
```typescript
                const result = await context.search({
                    text,
                    tags: [tag],
                    tokenBudget: definitionBudget,
                    minScore,
                    rerank: useEmbeddingRerank,
                    rerankThreshold: minScore,
                });
```

Gate the LLM rerank:
```typescript
            const useLlmRerank = (context.getTunableParam("llmRerank") ?? 0) > 0;
```

Then wrap the LLM rerank block:
```typescript
            if (useLlmRerank) {
                // ... existing LLM rerank code from Task 9 ...
            }
```

- [ ] **Step 3: Update engine-factory to set toggles per config**

In `tests-integration/kb-architecture/engine-factory.ts`, after domain registration, set tunable params based on config:

```typescript
    // Apply noise reduction toggles via tunable params
    if (config.noiseReduction) {
        const overrides: Record<string, number> = {};
        if (config.noiseReduction.embeddingRerank !== undefined) {
            overrides.embeddingRerank = config.noiseReduction.embeddingRerank ? 1 : 0;
        }
        if (config.noiseReduction.llmRerank !== undefined) {
            overrides.llmRerank = config.noiseReduction.llmRerank ? 1 : 0;
        }
        if (Object.keys(overrides).length > 0) {
            await engine.saveTunableParams("kb", overrides);
        }
    }
```

- [ ] **Step 4: Run full suite + lint + typecheck**

Run: `bun run lint && bun run typecheck && bun test`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
bun format
git add src/domains/kb/kb-domain.ts tests-integration/kb-architecture/engine-factory.ts
git commit -m "Make embedding and LLM rerank toggleable via tunable params and config"
```

---

## Task 11: Run Remaining Test Matrix

Run the remaining combinations: A+B, C+B, A+B+C. Stop at any point if targets are met.

- [ ] **Step 1: Run noise-reduce-AB**

```bash
bun run tests-integration/kb-architecture/run.ts --config noise-reduce-AB
```

Log results: `taskflow-cli log info "noise-reduce-AB: avg <score>/5, noise <noise>%, time <time>s"`

- [ ] **Step 2: Run noise-reduce-CB**

```bash
bun run tests-integration/kb-architecture/run.ts --config noise-reduce-CB
```

Log results: `taskflow-cli log info "noise-reduce-CB: avg <score>/5, noise <noise>%, time <time>s"`

- [ ] **Step 3: Run noise-reduce-ABC**

```bash
bun run tests-integration/kb-architecture/run.ts --config noise-reduce-ABC
```

Log results: `taskflow-cli log info "noise-reduce-ABC: avg <score>/5, noise <noise>%, time <time>s"`

- [ ] **Step 4: Generate report**

```bash
bun run tests-integration/kb-architecture/run.ts --report
```

- [ ] **Step 5: Log final findings**

```bash
taskflow-cli log info "<summary of all noise reduction results and best combination>"
```

- [ ] **Step 6: Commit all results**

```bash
git add tests-integration/kb-architecture/checkpoints/
git commit -m "Noise reduction testing loop: complete results for A, C, AC, AB, CB, ABC"
```
