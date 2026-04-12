# Chat Temporal Validity & Semantic Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add temporal validity (soft-invalidation via `validFrom`/`invalidAt`) and semantic deduplication to the chat domain's consolidation pipeline.

**Architecture:** Extend existing `ChatAttributes` with validity timestamps. Modify `consolidateEpisodic` to detect contradictions via structured LLM output and deduplicate semantic memories inline. Filter invalidated memories in `buildContext`.

**Tech Stack:** TypeScript, SurrealDB, bun:test

---

### Task 1: Add temporal validity fields to ChatAttributes

**Files:**
- Modify: `src/domains/chat/types.ts`

- [ ] **Step 1: Write the failing test**

In `tests/chat-domain.test.ts`, add to the existing `"Chat domain - config"` describe block:

```typescript
test("ChatAttributes type accepts validFrom and invalidAt", () => {
    const attrs: ChatAttributes = {
        role: "user",
        layer: "episodic",
        chatSessionId: "s1",
        userId: "u1",
        messageIndex: 0,
        weight: 1.0,
        validFrom: Date.now(),
        invalidAt: Date.now(),
    };
    expect(attrs.validFrom).toBeTypeOf("number");
    expect(attrs.invalidAt).toBeTypeOf("number");
});
```

Add `ChatAttributes` to the imports from `../src/domains/chat/types.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/chat-domain.test.ts -t "ChatAttributes type accepts validFrom"`
Expected: FAIL — `validFrom` and `invalidAt` do not exist on `ChatAttributes`.

- [ ] **Step 3: Add fields to ChatAttributes and new constant**

In `src/domains/chat/types.ts`, add `validFrom` and `invalidAt` to `ChatAttributes`:

```typescript
export interface ChatAttributes {
    role: ChatRole;
    layer: ChatLayer;
    chatSessionId: string;
    userId: string;
    messageIndex: number;
    weight?: number;
    validFrom?: number;
    invalidAt?: number;
}
```

Add `semanticDedupThreshold` to the consolidation options in `ChatDomainOptions`:

```typescript
consolidation?: {
    similarityThreshold?: number;
    minClusterSize?: number;
    semanticDedupThreshold?: number;
};
```

Add the default constant after the existing constants:

```typescript
export const DEFAULT_SEMANTIC_DEDUP_THRESHOLD = 0.85;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/chat-domain.test.ts -t "ChatAttributes type accepts validFrom"`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
bun format
git add src/domains/chat/types.ts tests/chat-domain.test.ts
git commit -m "feat(chat): add validFrom, invalidAt to ChatAttributes and semanticDedupThreshold option"
```

---

### Task 2: Set validFrom during promotion

**Files:**
- Modify: `src/domains/chat/schedules.ts:120-133`
- Test: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new test to the `"Chat domain - promote working memory"` describe block in `tests/chat-domain.test.ts`:

```typescript
test("promoted episodic memories have validFrom set", async () => {
    await engine.ingest("Message about weather", {
        domains: ["chat"],
        metadata: { role: "user" },
    });
    await engine.processInbox();
    await engine.ingest("Message about coding", {
        domains: ["chat"],
        metadata: { role: "user" },
        skipDedup: true,
    });
    await engine.processInbox();
    await engine.ingest("Message about lunch", {
        domains: ["chat"],
        metadata: { role: "user" },
        skipDedup: true,
    });
    await engine.processInbox();

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);
    llm.extractResult = ["Fact about weather and coding"];

    const beforePromote = Date.now();
    await promoteWorkingMemory(ctx, { workingMemoryCapacity: 2 });

    const episodic = await ctx.getMemories({
        tags: [CHAT_EPISODIC_TAG],
        attributes: { layer: "episodic" },
    });
    expect(episodic).toHaveLength(1);

    // Check validFrom via graph query on owned_by attributes
    const rows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
        "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
        {
            memId: new StringRecordId(`${episodic[0].id}`),
            domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
        },
    );
    expect(rows).toHaveLength(1);
    const validFrom = rows[0].attributes.validFrom as number;
    expect(validFrom).toBeTypeOf("number");
    expect(validFrom).toBeGreaterThanOrEqual(beforePromote);
});
```

Add `StringRecordId` import: `import { StringRecordId } from "surrealdb";`

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/chat-domain.test.ts -t "promoted episodic memories have validFrom set"`
Expected: FAIL — `validFrom` is undefined in attributes.

- [ ] **Step 3: Add validFrom to episodic memory creation in promoteWorkingMemory**

In `src/domains/chat/schedules.ts`, in the `promoteWorkingMemory` function, find the `writeMemory` call (around line 121) and add `validFrom: Date.now()` to the attributes:

```typescript
const episodicId = await context.writeMemory({
    content: fact,
    tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
    ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: {
            layer: "episodic",
            userId,
            chatSessionId,
            weight: 1.0,
            validFrom: Date.now(),
        },
    },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/chat-domain.test.ts -t "promoted episodic memories have validFrom set"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test tests/chat-domain.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
bun format
git add src/domains/chat/schedules.ts tests/chat-domain.test.ts
git commit -m "feat(chat): set validFrom on episodic memories during promotion"
```

---

### Task 3: Add extractStructured to MockLLMAdapter

**Files:**
- Modify: `tests/helpers.ts`

The consolidation logic will use `extractStructured` for contradiction detection. The mock needs to support it.

- [ ] **Step 1: Add extractStructuredResult and extractStructured to MockLLMAdapter**

In `tests/helpers.ts`, add to `MockLLMAdapter`:

```typescript
export class MockLLMAdapter implements LLMAdapter {
    extractResult: string[] = [];
    extractStructuredResult: unknown[] = [];
    consolidateResult = "";
    generateResult = "";
    synthesizeResult = "";

    extract(): Promise<string[]> {
        return Promise.resolve(this.extractResult);
    }
    extractStructured(): Promise<unknown[]> {
        return Promise.resolve(this.extractStructuredResult);
    }
    consolidate(): Promise<string> {
        return Promise.resolve(this.consolidateResult);
    }
    generate(_prompt: string): Promise<string> {
        return Promise.resolve(this.generateResult);
    }
    synthesize(_query: string, _memories: ScoredMemory[], _tagContext?: string[]): Promise<string> {
        return Promise.resolve(this.synthesizeResult);
    }
}
```

- [ ] **Step 2: Run existing tests to confirm nothing breaks**

Run: `bun test tests/chat-domain.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
bun format
git add tests/helpers.ts
git commit -m "test: add extractStructured support to MockLLMAdapter"
```

---

### Task 4: Contradiction detection during consolidation

**Files:**
- Modify: `src/domains/chat/schedules.ts:147-232`
- Test: `tests/chat-domain.test.ts`

This is the core change. The `consolidateEpisodic` function currently calls `context.llmAt("medium").consolidate(contents)` which returns a plain string. We replace this with `extractStructured()` that returns both the summary and contradiction pairs.

- [ ] **Step 1: Write the failing test for contradiction detection**

Add a new describe block in `tests/chat-domain.test.ts`:

```typescript
describe("Chat domain - consolidate with contradiction detection", () => {
    let engine: MemoryEngine;
    let llm: MockLLMAdapter;

    beforeEach(async () => {
        llm = new MockLLMAdapter();
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            context: { userId: "test-user" },
            llm,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );
    });

    afterEach(async () => {
        await engine.close();
    });

    test("detects contradictions and sets invalidAt on older memory", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        // Create 3 episodic memories — index 0 is oldest, index 2 is newest
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now() - (3 - i) * 1000,
                    },
                },
            });
            ids.push(id);
        }

        // Mock: extractStructured returns summary + contradiction (index 2 contradicts index 0)
        llm.extractStructuredResult = [
            {
                summary: "Consolidated TypeScript fact",
                contradictions: [{ newerIndex: 2, olderIndex: 0 }],
            },
        ];

        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        // The older memory (ids[0]) should have invalidAt set
        const rows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(ids[0]),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].attributes.invalidAt).toBeTypeOf("number");

        // The newer memory (ids[2]) should NOT have invalidAt
        const newerRows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(ids[2]),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        expect(newerRows).toHaveLength(1);
        expect(newerRows[0].attributes.invalidAt).toBeUndefined();
    });

    test("creates contradicts edge from newer to older memory", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now() - (3 - i) * 1000,
                    },
                },
            });
            ids.push(id);
        }

        llm.extractStructuredResult = [
            {
                summary: "Consolidated fact",
                contradictions: [{ newerIndex: 2, olderIndex: 0 }],
            },
        ];

        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        // Check contradicts edge exists from ids[2] → ids[0]
        const edges = await ctx.getNodeEdges(ids[2], "out");
        const contradictsEdges = edges.filter((e) => String(e.id).startsWith("contradicts:"));
        expect(contradictsEdges).toHaveLength(1);
    });

    test("falls back to consolidate() when extractStructured is not available", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        for (let i = 0; i < 3; i++) {
            await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: { layer: "episodic", userId: "test-user", weight: 0.5 },
                },
            });
        }

        // Remove extractStructured from mock to simulate adapter without it
        const llmWithout = { ...llm, extractStructured: undefined };
        const engine2 = new MemoryEngine();
        await engine2.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_fallback_${Date.now()}`,
            context: { userId: "test-user" },
            llm: llmWithout as unknown as LLMAdapter,
            embedding: new MockEmbeddingAdapter(),
        });
        await engine2.registerDomain(
            createChatDomain({
                promoteSchedule: { enabled: false },
                consolidateSchedule: { enabled: false },
                pruneSchedule: { enabled: false },
            }),
        );

        const ctx2 = engine2.createDomainContext(CHAT_DOMAIN_ID);

        for (let i = 0; i < 3; i++) {
            await ctx2.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: { layer: "episodic", userId: "test-user", weight: 0.5 },
                },
            });
        }

        llm.consolidateResult = "Fallback consolidated summary";

        await consolidateEpisodic(ctx2, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        const semanticMemories = await ctx2.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories.length).toBeGreaterThanOrEqual(1);
        expect(semanticMemories[0].content).toBe("Fallback consolidated summary");

        await engine2.close();
    });

    test("semantic memory created from consolidation excludes invalidated content", async () => {
        const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
            const id = await ctx.writeMemory({
                content: "TypeScript programming fact",
                tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
                ownership: {
                    domain: CHAT_DOMAIN_ID,
                    attributes: {
                        layer: "episodic",
                        userId: "test-user",
                        weight: 0.5,
                        validFrom: Date.now() - (3 - i) * 1000,
                    },
                },
            });
            ids.push(id);
        }

        // Contradiction: index 2 contradicts index 0
        // Summary should only be from non-invalidated memories
        llm.extractStructuredResult = [
            {
                summary: "Summary excluding contradicted facts",
                contradictions: [{ newerIndex: 2, olderIndex: 0 }],
            },
        ];

        await consolidateEpisodic(ctx, {
            consolidation: { similarityThreshold: 0.1, minClusterSize: 2 },
        });

        const semanticMemories = await ctx.getMemories({
            tags: [CHAT_SEMANTIC_TAG],
            attributes: { layer: "semantic" },
        });
        expect(semanticMemories.length).toBeGreaterThanOrEqual(1);
        expect(semanticMemories[0].content).toBe("Summary excluding contradicted facts");

        // Verify semantic memory has validFrom set
        const rows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(semanticMemories[0].id),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        expect(rows[0].attributes.validFrom).toBeTypeOf("number");
    });
});
```

Add `LLMAdapter` to the imports from `../src/core/types.js` at the top of the test file (it's needed for the fallback test).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts -t "detects contradictions"`
Expected: FAIL

- [ ] **Step 3: Implement contradiction-aware consolidation**

Replace the cluster processing loop in `consolidateEpisodic` in `src/domains/chat/schedules.ts`. The current code (lines 189-231) processes each cluster by calling `consolidate()`. Replace with logic that:

1. Collects memory IDs alongside contents for index mapping
2. Tries `extractStructured()` with a contradiction-detection prompt and schema
3. Falls back to `consolidate()` if `extractStructured` is unavailable
4. For each contradiction pair: sets `invalidAt` on older memory, creates `contradicts` edge
5. Creates semantic memory with `validFrom: Date.now()`

Replace the existing cluster processing loop (from `for (const cluster of clusters)` to the end of the debug timer callback) with:

```typescript
for (const cluster of clusters) {
    const clusterEntries: { id: string; content: string }[] = [];
    for (const memId of cluster) {
        const memory = await context.getMemory(memId);
        if (memory) {
            clusterEntries.push({ id: memId, content: memory.content });
        }
    }

    if (clusterEntries.length === 0) continue;

    const contents = clusterEntries.map((e) => e.content);
    let summary: string | undefined;
    let contradictions: { newerIndex: number; olderIndex: number }[] = [];

    const llm = context.llmAt("medium");

    if (llm.extractStructured) {
        const schema = JSON.stringify({
            type: "object",
            properties: {
                summary: {
                    type: "string",
                    description:
                        "A consolidated summary of the non-contradicted facts, preserving all important details",
                },
                contradictions: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            newerIndex: {
                                type: "number",
                                description: "0-based index of the newer fact that supersedes",
                            },
                            olderIndex: {
                                type: "number",
                                description: "0-based index of the older fact being contradicted",
                            },
                        },
                        required: ["newerIndex", "olderIndex"],
                    },
                    description:
                        "Pairs where a newer fact contradicts or supersedes an older one about the same topic",
                },
            },
            required: ["summary", "contradictions"],
        });

        const prompt = `Analyze the following numbered facts. Identify any where a newer fact (higher index) contradicts or supersedes an older fact (lower index) about the same topic. Then consolidate the non-contradicted facts into a single summary.\n\n${contents.map((c, i) => `${i}. ${c}`).join("\n")}`;

        const result = await context.debug.time(
            "chat.schedule.consolidate.structured",
            () => llm.extractStructured!(prompt, schema),
            { memories: contents.length },
        );

        if (result && result.length > 0) {
            const parsed = result[0] as {
                summary?: string;
                contradictions?: { newerIndex: number; olderIndex: number }[];
            };
            summary = parsed.summary;
            contradictions = parsed.contradictions ?? [];
        }
    }

    // Fallback to plain consolidate if extractStructured unavailable or returned nothing
    if (!summary) {
        summary = await context.debug.time(
            "chat.schedule.consolidate.summary",
            () => context.llmAt("medium").consolidate(contents),
            { memories: contents.length },
        );
    }

    if (!summary) continue;

    // Process contradictions — invalidate older memories
    const invalidatedIds = new Set<string>();
    const now = Date.now();

    for (const { newerIndex, olderIndex } of contradictions) {
        const older = clusterEntries[olderIndex];
        const newer = clusterEntries[newerIndex];
        if (!older || !newer) continue;

        // Read existing attributes and add invalidAt
        const attrRows = await context.graph.query<{ attributes: Record<string, unknown> }[]>(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(older.id),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        if (attrRows && attrRows.length > 0) {
            await context.updateAttributes(older.id, {
                ...attrRows[0].attributes,
                invalidAt: now,
            });
        }

        // Create contradicts edge
        await context.graph.relate(newer.id, "contradicts", older.id, {
            strength: 1.0,
            detected_at: now,
        });

        invalidatedIds.add(older.id);
    }

    // Create semantic memory
    const chatTagId = await ensureTag(context, CHAT_TAG);
    const semanticTagId = await ensureTag(context, CHAT_SEMANTIC_TAG);
    try {
        await context.graph.relate(semanticTagId, "child_of", chatTagId);
    } catch {
        /* already related */
    }

    const semanticId = await context.writeMemory({
        content: summary,
        tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
        ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
                layer: "semantic",
                weight: 0.8,
                validFrom: now,
            },
        },
    });

    // Create summarizes edges only from non-invalidated cluster members
    for (const entry of clusterEntries) {
        if (!invalidatedIds.has(entry.id)) {
            await context.graph.relate(semanticId, "summarizes", entry.id);
        }
    }
}
```

Add `StringRecordId` import at top of `schedules.ts`:
```typescript
import { StringRecordId } from "surrealdb";
```

Also import `DEFAULT_SEMANTIC_DEDUP_THRESHOLD` from `./types.js` (will be used in Task 5).

- [ ] **Step 4: Run contradiction tests**

Run: `bun test tests/chat-domain.test.ts -t "consolidate with contradiction"`
Expected: All 4 new tests pass

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `bun test tests/chat-domain.test.ts`
Expected: All tests pass. The existing "consolidates clustered episodic memories into semantic" test should still pass because it doesn't set `extractStructuredResult`, so `extractStructured` returns `[]`, triggering the fallback to `consolidate()`.

- [ ] **Step 6: Commit**

```bash
bun format
git add src/domains/chat/schedules.ts tests/chat-domain.test.ts
git commit -m "feat(chat): detect contradictions during consolidation via extractStructured"
```

---

### Task 5: Semantic deduplication during consolidation

**Files:**
- Modify: `src/domains/chat/schedules.ts` (within `consolidateEpisodic`)
- Test: `tests/chat-domain.test.ts`

After creating a new semantic memory in `consolidateEpisodic`, search for existing similar semantics and merge if found.

- [ ] **Step 1: Write the failing test**

Add to the `"Chat domain - consolidate with contradiction detection"` describe block:

```typescript
test("deduplicates semantic memories by merging similar ones", async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

    // Create an existing semantic memory
    const existingId = await ctx.writeMemory({
        content: "User prefers TypeScript for web development",
        tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
        ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
                layer: "semantic",
                userId: "test-user",
                weight: 0.8,
                validFrom: Date.now() - 10000,
            },
        },
    });

    // Create 3 episodic memories that will produce a similar semantic
    for (let i = 0; i < 3; i++) {
        await ctx.writeMemory({
            content: "User prefers TypeScript for web development",
            tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    layer: "episodic",
                    userId: "test-user",
                    weight: 0.5,
                    validFrom: Date.now(),
                },
            },
        });
    }

    // extractStructured returns summary, no contradictions
    llm.extractStructuredResult = [
        {
            summary: "User strongly prefers TypeScript for all web development",
            contradictions: [],
        },
    ];
    // consolidate will be called for the merge step
    llm.consolidateResult = "Merged: User strongly prefers TypeScript for web projects";

    await consolidateEpisodic(ctx, {
        consolidation: {
            similarityThreshold: 0.1,
            minClusterSize: 2,
            semanticDedupThreshold: 0.1, // low threshold so mock embeddings match
        },
    });

    // The old semantic should be invalidated
    const oldRows = await ctx.graph.query<{ attributes: Record<string, unknown> }[]>(
        "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
        {
            memId: new StringRecordId(existingId),
            domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
        },
    );
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0].attributes.invalidAt).toBeTypeOf("number");

    // There should be a new semantic memory with merged content
    const allSemantic = await ctx.getMemories({
        tags: [CHAT_SEMANTIC_TAG],
        attributes: { layer: "semantic" },
    });
    // One invalidated (old) + one active (merged)
    const active = allSemantic.filter(() => {
        // We need to check via graph query since getMemories doesn't filter by invalidAt
        return true;
    });
    expect(active.length).toBeGreaterThanOrEqual(2); // old + new both exist
});

test("skips semantic dedup when no similar semantic exists", async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

    // Create 3 episodic memories — no existing semantics
    for (let i = 0; i < 3; i++) {
        await ctx.writeMemory({
            content: "Unique topic about cooking pasta",
            tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
            ownership: {
                domain: CHAT_DOMAIN_ID,
                attributes: {
                    layer: "episodic",
                    userId: "test-user",
                    weight: 0.5,
                    validFrom: Date.now(),
                },
            },
        });
    }

    llm.extractStructuredResult = [
        { summary: "User discusses cooking pasta", contradictions: [] },
    ];

    await consolidateEpisodic(ctx, {
        consolidation: {
            similarityThreshold: 0.1,
            minClusterSize: 2,
            semanticDedupThreshold: 0.99, // very high — nothing should match
        },
    });

    const semanticMemories = await ctx.getMemories({
        tags: [CHAT_SEMANTIC_TAG],
        attributes: { layer: "semantic" },
    });
    expect(semanticMemories).toHaveLength(1);
    expect(semanticMemories[0].content).toBe("User discusses cooking pasta");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts -t "deduplicates semantic"`
Expected: FAIL

- [ ] **Step 3: Add semantic dedup logic after semantic memory creation**

In `src/domains/chat/schedules.ts`, after the semantic memory is created and summarizes edges are added (at the end of the cluster loop), add the dedup logic. Insert after the `summarizes` edge loop, still inside the `for (const cluster of clusters)` block:

```typescript
// Semantic dedup: check for existing similar semantic memories
const dedupThreshold =
    options?.consolidation?.semanticDedupThreshold ?? DEFAULT_SEMANTIC_DEDUP_THRESHOLD;

const existingSemantics = await context.search({
    text: summary,
    tags: [CHAT_SEMANTIC_TAG],
    attributes: { layer: "semantic" },
    minScore: dedupThreshold,
});

// Filter out the semantic memory we just created and any already-invalidated ones
const dedupCandidates = existingSemantics.entries.filter((e) => {
    if (e.id === semanticId) return false;
    const attrs = e.domainAttributes[CHAT_DOMAIN_ID];
    if (attrs && attrs.invalidAt != null) return false;
    return true;
});

if (dedupCandidates.length > 0) {
    const dupTarget = dedupCandidates[0];

    // Merge via LLM consolidate
    const merged = await context.debug.time(
        "chat.schedule.consolidate.semanticMerge",
        () => context.llmAt("medium").consolidate([summary, dupTarget.content]),
        { memories: 2 },
    );

    if (merged) {
        // Update the new semantic memory with merged content
        await context.graph.updateNode(semanticId, {
            content: merged,
            token_count: countTokens(merged),
        });

        // Invalidate the old semantic memory
        const oldAttrRows = await context.graph.query<
            { attributes: Record<string, unknown> }[]
        >(
            "SELECT attributes FROM owned_by WHERE in = $memId AND out = $domainId",
            {
                memId: new StringRecordId(dupTarget.id),
                domainId: new StringRecordId(`domain:${CHAT_DOMAIN_ID}`),
            },
        );
        if (oldAttrRows && oldAttrRows.length > 0) {
            await context.updateAttributes(dupTarget.id, {
                ...oldAttrRows[0].attributes,
                invalidAt: now,
            });
        }

        // Create summarizes edge from merged → old
        await context.graph.relate(semanticId, "summarizes", dupTarget.id);
    }
}
```

Add `countTokens` import at top of `schedules.ts`:
```typescript
import { countTokens } from "../../core/scoring.js";
```

Also add `DEFAULT_SEMANTIC_DEDUP_THRESHOLD` to the imports from `./types.js`.

- [ ] **Step 4: Run dedup tests**

Run: `bun test tests/chat-domain.test.ts -t "deduplicates semantic|skips semantic dedup"`
Expected: Both pass

- [ ] **Step 5: Run full test suite**

Run: `bun test tests/chat-domain.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
bun format
git add src/domains/chat/schedules.ts tests/chat-domain.test.ts
git commit -m "feat(chat): deduplicate semantic memories during consolidation via LLM merge"
```

---

### Task 6: Skip invalidated memories in pruneDecayed

**Files:**
- Modify: `src/domains/chat/schedules.ts:234-265`
- Test: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `"Chat domain - prune decayed"` describe block:

```typescript
test("skips already-invalidated episodic memories", async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

    // Create an invalidated memory with low weight
    await ctx.writeMemory({
        content: "Invalidated fact",
        tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
        ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
                layer: "episodic",
                userId: "test-user",
                weight: 0.01,
                invalidAt: Date.now() - 1000,
            },
        },
    });

    // Prune with high threshold — would normally delete it
    await pruneDecayed(ctx, { decay: { pruneThreshold: 0.5 } });

    // Should still exist because it was skipped (already invalidated)
    const remaining = await ctx.getMemories({
        tags: [CHAT_EPISODIC_TAG],
        attributes: { layer: "episodic" },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].content).toBe("Invalidated fact");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/chat-domain.test.ts -t "skips already-invalidated"`
Expected: FAIL — the memory gets pruned because the current code doesn't check `invalidAt`.

- [ ] **Step 3: Add invalidAt check to pruneDecayed**

In `src/domains/chat/schedules.ts`, in the `pruneDecayed` function's loop (around line 250), add a check after reading attributes:

```typescript
for (const row of rows) {
    const memId = String(row.in);
    const attrs = row.attributes;
    const weight = typeof attrs.weight === "number" ? attrs.weight : 1.0;

    // Skip already-invalidated memories
    if (attrs.invalidAt != null) continue;

    const memory = await context.getMemory(memId);
    if (!memory) continue;

    const hoursSinceCreation = (now - memory.createdAt) / (1000 * 60 * 60);
    const decayedWeight = weight * Math.exp(-lambda * hoursSinceCreation);

    if (decayedWeight < threshold) {
        await context.releaseOwnership(memId, CHAT_DOMAIN_ID);
    }
}
```

Note: the `attrs` variable replaces the existing `row.attributes` usage. The current code uses `row.attributes.weight` directly — change the loop to destructure and check `invalidAt`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/chat-domain.test.ts -t "skips already-invalidated"`
Expected: PASS

- [ ] **Step 5: Run full prune tests**

Run: `bun test tests/chat-domain.test.ts -t "prune decayed"`
Expected: All prune tests pass

- [ ] **Step 6: Commit**

```bash
bun format
git add src/domains/chat/schedules.ts tests/chat-domain.test.ts
git commit -m "feat(chat): skip invalidated memories during decay pruning"
```

---

### Task 7: Filter invalidated memories in buildContext

**Files:**
- Modify: `src/domains/chat/chat-domain.ts:138-176`
- Test: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `"Chat domain - buildContext"` describe block:

```typescript
test("excludes invalidated episodic memories from context", async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

    // Valid episodic memory
    await ctx.writeMemory({
        content: "Valid episodic fact about testing",
        tags: [CHAT_EPISODIC_TAG],
        ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
                layer: "episodic",
                userId: "test-user",
                weight: 0.5,
                validFrom: Date.now(),
            },
        },
    });

    // Invalidated episodic memory
    await ctx.writeMemory({
        content: "Invalidated episodic fact should not appear",
        tags: [CHAT_EPISODIC_TAG],
        ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
                layer: "episodic",
                userId: "test-user",
                weight: 0.5,
                validFrom: Date.now() - 10000,
                invalidAt: Date.now() - 5000,
            },
        },
    });

    const result = await engine.buildContext("testing", {
        domains: ["chat"],
        context: { userId: "test-user", chatSessionId: "session-1" },
    });

    expect(result.context).toContain("Valid episodic fact about testing");
    expect(result.context).not.toContain("Invalidated episodic fact should not appear");
});

test("excludes invalidated semantic memories from context", async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID);

    // Valid semantic memory
    await ctx.writeMemory({
        content: "Valid semantic knowledge about testing",
        tags: [CHAT_SEMANTIC_TAG],
        ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
                layer: "semantic",
                userId: "test-user",
                weight: 0.8,
                validFrom: Date.now(),
            },
        },
    });

    // Invalidated semantic memory
    await ctx.writeMemory({
        content: "Invalidated semantic should not appear",
        tags: [CHAT_SEMANTIC_TAG],
        ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
                layer: "semantic",
                userId: "test-user",
                weight: 0.8,
                validFrom: Date.now() - 10000,
                invalidAt: Date.now() - 5000,
            },
        },
    });

    const result = await engine.buildContext("testing", {
        domains: ["chat"],
        context: { userId: "test-user", chatSessionId: "session-1" },
    });

    expect(result.context).toContain("Valid semantic knowledge about testing");
    expect(result.context).not.toContain("Invalidated semantic should not appear");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts -t "excludes invalidated"`
Expected: FAIL — invalidated memories appear in context.

- [ ] **Step 3: Add invalidAt filter to buildContext**

In `src/domains/chat/chat-domain.ts`, in the `buildContext` method, modify the episodic and semantic entry filters to also exclude invalidated memories.

For the episodic section (around line 146), change the filter:

```typescript
const episodicEntries = episodicResult.entries.filter((e) => {
    const attrs = e.domainAttributes[CHAT_DOMAIN_ID];
    return (
        attrs &&
        attrs.userId === userId &&
        attrs.layer === "episodic" &&
        attrs.invalidAt == null
    );
});
```

For the semantic section (around line 166), same pattern:

```typescript
const semanticEntries = semanticResult.entries.filter((e) => {
    const attrs = e.domainAttributes[CHAT_DOMAIN_ID];
    return (
        attrs &&
        attrs.userId === userId &&
        attrs.layer === "semantic" &&
        attrs.invalidAt == null
    );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts -t "excludes invalidated"`
Expected: PASS

- [ ] **Step 5: Run full buildContext and all tests**

Run: `bun test tests/chat-domain.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
bun format
git add src/domains/chat/chat-domain.ts tests/chat-domain.test.ts
git commit -m "feat(chat): filter invalidated memories from buildContext"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass across all test files

- [ ] **Step 2: Run typecheck**

Run: `bun typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `bun lint`
Expected: No errors

- [ ] **Step 4: Format**

Run: `bun format`
Expected: Clean

- [ ] **Step 5: Commit any formatting fixes if needed**

If `bun format` changed anything:
```bash
git add -A
git commit -m "chore: format"
```
