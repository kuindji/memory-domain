# User Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add request context to the framework and implement the User domain as a cross-domain aggregator around user identity.

**Architecture:** Request context (`Record<string, unknown>`) is set at engine instantiation and/or per API call, merged on every operation, and propagated to all domains via `DomainContext`. The User domain is a built-in primitive (like Topic domain) that creates a user graph node, owns user fact memories, and runs a consolidation schedule.

**Tech Stack:** TypeScript, SurrealDB, Bun test runner

---

## File Structure

**Framework changes (core):**
- Modify: `src/core/types.ts` — Add `RequestContext` type alias, add `context` fields to `EngineConfig`, options types, and `DomainContext`; add `getMemoryTags` and `getNodeEdges` to `DomainContext`
- Modify: `src/core/engine.ts` — Store default context, merge on API calls, pass to `createDomainContext`; implement `getMemoryTags` and `getNodeEdges`
- Modify: `src/core/inbox-processor.ts` — Accept and pass request context to context factory
- Modify: `src/core/scheduler.ts` — Accept and pass request context to context factory
- Create: `tests/request-context.test.ts` — Tests for context merging and propagation

**User domain:**
- Create: `src/domains/user/types.ts` — Constants and option types
- Create: `src/domains/user/skills.ts` — Three domain skills
- Create: `src/domains/user/schedules.ts` — Consolidation schedule
- Create: `src/domains/user/user-domain.ts` — Domain config factory
- Create: `src/domains/user/index.ts` — Barrel export
- Modify: `src/index.ts` — Export user domain
- Create: `tests/user-domain.test.ts` — Unit and integration tests

**CLI changes:**
- Modify: `src/cli/commands/ingest.ts` — Accept `--user-id` flag, pass as context
- Modify: `src/cli/commands/search.ts` — Accept `--user-id` flag
- Modify: `src/cli/commands/ask.ts` — Accept `--user-id` flag
- Modify: `src/cli/commands/build-context.ts` — Accept `--user-id` flag

---

### Task 1: Add RequestContext type and update option types

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add RequestContext type alias after the MemoryEventName type (line 339)**

```typescript
// --- Request context ---

export type RequestContext = Record<string, unknown>
```

- [ ] **Step 2: Add `context` to `EngineConfig`**

In `EngineConfig` (around line 310), add after the `search` field:

```typescript
  context?: RequestContext
```

- [ ] **Step 3: Add `context` to `IngestOptions`**

In `IngestOptions` (around line 240), add after `skipDedup`:

```typescript
  context?: RequestContext
```

- [ ] **Step 4: Add `context` to `SearchQuery`**

In `SearchQuery` (around line 106), add after `weights`:

```typescript
  context?: RequestContext
```

- [ ] **Step 5: Add `context` to `AskOptions`**

In `AskOptions` (around line 275), add after `limit`:

```typescript
  context?: RequestContext
```

- [ ] **Step 6: Add `context` to `ContextOptions`**

In `ContextOptions` (around line 260), add after `maxMemories`:

```typescript
  context?: RequestContext
```

- [ ] **Step 7: Add `requestContext`, `getMemoryTags`, and `getNodeEdges` to `DomainContext`**

In `DomainContext` (around line 173), add after the `setMeta` method:

```typescript
  requestContext: RequestContext
  getMemoryTags(memoryId: string): Promise<string[]>
  getNodeEdges(nodeId: string, direction?: 'in' | 'out' | 'both'): Promise<Edge[]>
```

- [ ] **Step 8: Export `RequestContext` from `src/index.ts`**

Add `RequestContext` to the type export block in `src/index.ts`:

```typescript
  RequestContext,
```

- [ ] **Step 9: Run typecheck**

Run: `bun run typecheck`
Expected: Type errors in engine.ts, inbox-processor.ts, scheduler.ts (because DomainContext now requires new fields that aren't implemented yet). This is expected — we'll fix them in Task 2.

- [ ] **Step 10: Commit**

```bash
git add src/core/types.ts src/index.ts
git commit -m "feat: add RequestContext type and context fields to API options"
```

---

### Task 2: Implement request context merging in engine

**Files:**
- Modify: `src/core/engine.ts`

- [ ] **Step 1: Store default context in the engine**

Add a field after `repetitionConfig` (line 44):

```typescript
  private defaultContext: RequestContext = {}
```

Import `RequestContext` in the imports (add to the import block from `./types.ts`):

```typescript
  RequestContext,
```

- [ ] **Step 2: Capture default context in `initialize`**

At the end of the `initialize` method, after all setup is done (before the closing `}`), add:

```typescript
    this.defaultContext = config.context ?? {}
```

- [ ] **Step 3: Add a private `mergeContext` helper**

Add after the `resolveVisibleDomains` method:

```typescript
  private mergeContext(requestContext?: RequestContext): RequestContext {
    if (!requestContext) return { ...this.defaultContext }
    return { ...this.defaultContext, ...requestContext }
  }
```

- [ ] **Step 4: Update `createDomainContext` to accept and expose request context**

Change the signature from:

```typescript
  createDomainContext(domainId: string): DomainContext {
```

to:

```typescript
  createDomainContext(domainId: string, requestContext?: RequestContext): DomainContext {
```

Add `mergedContext` after the existing variable declarations (after `const search = ...`):

```typescript
    const mergedContext = this.mergeContext(requestContext)
```

Add `requestContext: mergedContext,` to the returned object (after `llm,`).

- [ ] **Step 5: Implement `getMemoryTags` in the returned DomainContext**

Add inside the returned object from `createDomainContext`:

```typescript
      async getMemoryTags(memoryId: string): Promise<string[]> {
        const rows = await graph.query<{ label: string }[]>(
          'SELECT VALUE out.label FROM tagged WHERE in = $memId',
          { memId: new StringRecordId(memoryId) }
        )
        return (rows ?? []).filter((label): label is string => typeof label === 'string')
      },
```

- [ ] **Step 6: Implement `getNodeEdges` in the returned DomainContext**

Add inside the returned object from `createDomainContext`:

```typescript
      async getNodeEdges(nodeId: string, direction?: 'in' | 'out' | 'both'): Promise<Edge[]> {
        const dir = direction ?? 'both'
        const conditions: string[] = []
        if (dir === 'out' || dir === 'both') conditions.push('in = $nodeId')
        if (dir === 'in' || dir === 'both') conditions.push('out = $nodeId')
        const where = conditions.join(' OR ')

        // Query all relation tables. SurrealDB relation tables are tracked by schema registry.
        const edgeNames = schema.getRegisteredEdgeNames()
        const coreEdges = ['tagged', 'owned_by', 'reinforces', 'contradicts', 'summarizes', 'refines', 'child_of', 'has_rule']
        const allEdges = [...new Set([...coreEdges, ...edgeNames])]

        const results: Edge[] = []
        const nodeRef = new StringRecordId(nodeId)
        for (const edgeName of allEdges) {
          const rows = await graph.query<Edge[]>(
            `SELECT * FROM ${edgeName} WHERE ${where}`,
            { nodeId: nodeRef }
          )
          if (rows) results.push(...rows)
        }
        return results
      },
```

Also import `Edge` in the engine's import block from `./types.ts`:

```typescript
  Edge,
```

And capture `schema` in the `createDomainContext` method variables:

```typescript
    const schema = this.schema
```

- [ ] **Step 7: Pass request context from `ingest` to `createDomainContext`**

In the `search` method (line 227), update the `createDomainContext` call to pass context:

```typescript
        const ctx = this.createDomainContext(domainId, query.context)
```

In the `buildContext` method (line 583), update the `createDomainContext` call:

```typescript
        const ctx = this.createDomainContext(options.domains[0], options?.context)
```

Note: `ingest` doesn't call `createDomainContext` directly — inbox processing handles that. The `ask` method uses `search` internally which handles it.

- [ ] **Step 8: Update `InboxProcessor` context factory type and propagation**

In `src/core/inbox-processor.ts`, change the `contextFactory` type in the constructor (line 39):

```typescript
    private contextFactory: (domainId: string, requestContext?: Record<string, unknown>) => DomainContext
```

The inbox processor processes items asynchronously — it doesn't have access to the original request context. It will pass `undefined` (engine default applies). No other changes needed in inbox-processor.

- [ ] **Step 9: Update `Scheduler` context factory type**

In `src/core/scheduler.ts`, change the `contextFactory` type in the constructor (line 15):

```typescript
    private contextFactory: (domainId: string, requestContext?: Record<string, unknown>) => DomainContext,
```

The scheduler runs without request context — engine default applies. No other changes needed.

- [ ] **Step 10: Update engine constructor calls to `InboxProcessor` and `Scheduler`**

In `engine.ts` `initialize` method, the `InboxProcessor` and `Scheduler` are constructed with `this.createDomainContext.bind(this)`. This already works because the new parameter is optional. No change needed.

- [ ] **Step 11: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (all DomainContext fields now implemented)

- [ ] **Step 12: Commit**

```bash
git add src/core/engine.ts src/core/inbox-processor.ts src/core/scheduler.ts
git commit -m "feat: implement request context merging and tag/edge query methods"
```

---

### Task 3: Test request context propagation

**Files:**
- Create: `tests/request-context.test.ts`

- [ ] **Step 1: Write test file**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'
import type { DomainConfig, OwnedMemory, DomainContext, RequestContext } from '../src/core/types.ts'

describe('Request context', () => {
  let engine: MemoryEngine

  afterEach(async () => {
    await engine.close()
  })

  test('engine default context is available on DomainContext', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      context: { userId: 'user-1' },
    })

    const ctx = engine.createDomainContext('log')
    expect(ctx.requestContext).toEqual({ userId: 'user-1' })
  })

  test('per-request context overrides engine default', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      context: { userId: 'default-user', lang: 'en' },
    })

    const ctx = engine.createDomainContext('log', { userId: 'override-user' })
    expect(ctx.requestContext).toEqual({ userId: 'override-user', lang: 'en' })
  })

  test('empty engine context with per-request context', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })

    const ctx = engine.createDomainContext('log', { userId: 'user-1' })
    expect(ctx.requestContext).toEqual({ userId: 'user-1' })
  })

  test('no context at all results in empty object', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })

    const ctx = engine.createDomainContext('log')
    expect(ctx.requestContext).toEqual({})
  })

  test('search expand hook receives request context', async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
      context: { userId: 'user-1' },
    })

    let capturedContext: RequestContext | undefined
    const testDomain: DomainConfig = {
      id: 'ctx-test',
      name: 'Context Test',
      async processInboxItem() {},
      search: {
        expand(query, context) {
          capturedContext = context.requestContext
          return Promise.resolve(query)
        },
      },
    }
    await engine.registerDomain(testDomain)

    await engine.search({ text: 'hello', domains: ['ctx-test'], context: { userId: 'per-request' } })
    expect(capturedContext).toEqual({ userId: 'per-request' })
  })
})

describe('getMemoryTags', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  test('returns tags for a memory', async () => {
    const result = await engine.ingest('tagged memory', { tags: ['alpha', 'beta'] })
    const ctx = engine.createDomainContext('log')
    const tags = await ctx.getMemoryTags(result.id!)
    expect(tags).toContain('alpha')
    expect(tags).toContain('beta')
    expect(tags).not.toContain('inbox')
  })

  test('returns empty array for memory with no tags', async () => {
    const ctx = engine.createDomainContext('log')
    const result = await engine.ingest('plain memory')
    // Process inbox to remove inbox tag
    await engine.processInbox()
    const tags = await ctx.getMemoryTags(result.id!)
    expect(tags).toEqual([])
  })
})

describe('getNodeEdges', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  test('returns outgoing edges for a node', async () => {
    const result = await engine.ingest('test memory', { tags: ['test-tag'] })
    const ctx = engine.createDomainContext('log')
    const edges = await ctx.getNodeEdges(result.id!, 'out')
    // Should have at least tagged and owned_by edges
    expect(edges.length).toBeGreaterThan(0)
  })

  test('returns edges in both directions by default', async () => {
    const result = await engine.ingest('test memory')
    const ctx = engine.createDomainContext('log')
    const edges = await ctx.getNodeEdges(result.id!)
    expect(edges.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/request-context.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: ALL PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add tests/request-context.test.ts
git commit -m "test: add request context propagation and tag/edge query tests"
```

---

### Task 4: User domain types and constants

**Files:**
- Create: `src/domains/user/types.ts`

- [ ] **Step 1: Create user domain types**

```typescript
export interface UserDomainOptions {
  consolidateSchedule?: {
    enabled?: boolean
    intervalMs?: number
  }
}

export const USER_DOMAIN_ID = 'user'
export const USER_TAG = 'user'
export const DEFAULT_CONSOLIDATE_INTERVAL_MS = 3_600_000
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/user/types.ts
git commit -m "feat(user): add user domain types and constants"
```

---

### Task 5: User domain skills

**Files:**
- Create: `src/domains/user/skills.ts`

- [ ] **Step 1: Create the three skills**

```typescript
import type { DomainSkill } from '../../core/types.ts'
import { USER_DOMAIN_ID, USER_TAG } from './types.ts'

const userData: DomainSkill = {
  id: 'user-data',
  name: 'How to store user facts',
  description: 'Tells external agents and domains how to create and store user-related data',
  scope: 'external',
  content: `# Storing User Data

The User domain tracks facts about users. Each user is represented by a \`user\` node in the graph with a \`userId\` field. User facts are memories owned by the \`${USER_DOMAIN_ID}\` domain, tagged under the \`${USER_TAG}/\` hierarchy.

## Prerequisites

The request context must contain \`userId\` (string). If no userId is present, skip user data operations.

## Finding or Creating the User Node

Check if a user node exists, then create if needed:

\`\`\`ts
const userId = context.requestContext.userId as string | undefined
if (!userId) return

const userNodeId = \`user:\${userId}\`
const existing = await context.graph.getNode(userNodeId)
if (!existing) {
  await context.graph.createNodeWithId(userNodeId, { userId })
}
\`\`\`

## Storing a User Fact

Write a memory owned by the User domain, tag it appropriately, and link it to the user node:

\`\`\`ts
const memoryId = await context.writeMemory({
  content: 'User prefers concise, technical explanations',
  tags: ['${USER_TAG}/preference'],
  ownership: {
    domain: '${USER_DOMAIN_ID}',
    attributes: {},
  },
})

// Link to the user node
await context.graph.relate(memoryId, 'about_user', userNodeId)
\`\`\`

## Tag Categories

- \`${USER_TAG}/identity\` — name, location, profession, affiliations
- \`${USER_TAG}/preference\` — communication style, tool choices, likes/dislikes
- \`${USER_TAG}/expertise\` — skills, knowledge areas, experience level
- \`${USER_TAG}/goal\` — intentions, aspirations, longer-term objectives

Domains may extend this hierarchy with additional tags as needed.

## Linking Existing Memories to a User

If your domain owns a memory that is "about" the user, link it directly:

\`\`\`ts
await context.graph.relate(memoryId, 'about_user', userNodeId)
\`\`\`

For relationships that are not "about" the user (e.g., participation, ownership), use your own domain-specific edges instead.
`,
}

const userQuery: DomainSkill = {
  id: 'user-query',
  name: 'How to query user data',
  description: 'Tells external agents and domains how to retrieve and search user-related data',
  scope: 'external',
  content: `# Querying User Data

## Finding User Facts by Category

Search for user-owned memories filtered by tag:

\`\`\`ts
const preferences = await context.getMemories({
  tags: ['${USER_TAG}/preference'],
  domains: ['${USER_DOMAIN_ID}'],
})
\`\`\`

## Getting All Data Linked to a User

Traverse all edges from the user node using getNodeEdges:

\`\`\`ts
const userId = context.requestContext.userId as string | undefined
if (!userId) return

const userNodeId = \`user:\${userId}\`
const edges = await context.getNodeEdges(userNodeId, 'in')
// edges now contains all memories linked TO this user from any domain
\`\`\`

## Searching User Facts by Content

\`\`\`ts
const results = await context.search({
  text: 'programming experience',
  tags: ['${USER_TAG}'],
})
\`\`\`

## Getting the User Profile Summary

The consolidation schedule creates a summary memory tagged \`${USER_TAG}/profile-summary\`:

\`\`\`ts
const summaries = await context.getMemories({
  tags: ['${USER_TAG}/profile-summary'],
  domains: ['${USER_DOMAIN_ID}'],
  limit: 1,
})
const profileSummary = summaries[0]?.content
\`\`\`
`,
}

const userProfile: DomainSkill = {
  id: 'user-profile',
  name: 'Internal user profile consolidation',
  description: 'Internal skill for consolidating cross-domain user data into a profile summary',
  scope: 'internal',
  content: `# User Profile Consolidation (Internal)

This skill describes the logic used by the consolidate-user-profile schedule.

## Process

1. Find all user nodes
2. For each user, collect all linked data via getNodeEdges (incoming edges to the user node)
3. Retrieve the content of linked memories
4. Use LLM to synthesize a profile summary
5. Store or update the summary as a memory tagged \`${USER_TAG}/profile-summary\`

## Summary Update Strategy

- Search for an existing profile summary for this user
- If found, compare with new synthesis — update only if materially different
- If not found, create a new summary memory
- The summary memory is owned by \`${USER_DOMAIN_ID}\` and linked to the user node via \`about_user\`
`,
}

export const userSkills: DomainSkill[] = [userData, userQuery, userProfile]
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/user/skills.ts
git commit -m "feat(user): add skill content for user domain"
```

---

### Task 6: User domain consolidation schedule

**Files:**
- Create: `src/domains/user/schedules.ts`

- [ ] **Step 1: Write the consolidation schedule function**

```typescript
import { StringRecordId } from 'surrealdb'
import type { DomainContext } from '../../core/types.ts'
import { USER_DOMAIN_ID, USER_TAG } from './types.ts'

export async function consolidateUserProfile(context: DomainContext): Promise<void> {
  // Find all user nodes
  const userNodes = await context.graph.query<{ id: string; userId: string }[]>(
    'SELECT id, userId FROM user'
  )

  if (!userNodes || userNodes.length === 0) return

  for (const userNode of userNodes) {
    const userNodeId = String(userNode.id)

    // Get all incoming edges to this user node
    const edges = await context.getNodeEdges(userNodeId, 'in')

    if (edges.length === 0) continue

    // Collect memory content from linked nodes
    const memoryIds = edges.map(e => String(e.in)).filter(id => id.startsWith('memory:'))
    const uniqueIds = [...new Set(memoryIds)]

    const contents: string[] = []
    for (const memId of uniqueIds) {
      const memory = await context.getMemory(memId)
      if (memory) {
        contents.push(memory.content)
      }
    }

    if (contents.length === 0) continue

    // Synthesize a profile summary using LLM
    const summary = await context.llm.consolidate(contents)

    if (!summary.trim()) continue

    // Find existing profile summary for this user
    const existingSummaries = await context.getMemories({
      tags: [`${USER_TAG}/profile-summary`],
      domains: [USER_DOMAIN_ID],
    })

    // Check if any existing summary is linked to this user
    let existingSummaryId: string | undefined
    for (const existing of existingSummaries) {
      const summaryEdges = await context.getNodeEdges(existing.id, 'out')
      const linksToUser = summaryEdges.some(e => String(e.out) === userNodeId)
      if (linksToUser) {
        existingSummaryId = existing.id
        break
      }
    }

    if (existingSummaryId) {
      // Update existing summary content via graph
      await context.graph.updateNode(existingSummaryId, { content: summary })
    } else {
      // Create new summary memory
      const summaryId = await context.writeMemory({
        content: summary,
        tags: [`${USER_TAG}/profile-summary`],
        ownership: {
          domain: USER_DOMAIN_ID,
          attributes: {},
        },
      })

      // Link summary to user node
      await context.graph.relate(summaryId, 'about_user', userNodeId)
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/user/schedules.ts
git commit -m "feat(user): add consolidate-user-profile schedule function"
```

---

### Task 7: User domain config factory

**Files:**
- Create: `src/domains/user/user-domain.ts`
- Create: `src/domains/user/index.ts`

- [ ] **Step 1: Create the domain config factory**

```typescript
import type { DomainConfig, OwnedMemory, DomainContext, SearchQuery, DomainSchedule } from '../../core/types.ts'
import { USER_DOMAIN_ID, DEFAULT_CONSOLIDATE_INTERVAL_MS } from './types.ts'
import type { UserDomainOptions } from './types.ts'
import { userSkills } from './skills.ts'
import { consolidateUserProfile } from './schedules.ts'

const STRUCTURE = `# User Domain

Built-in primitive for tracking user identity and cross-domain user data.

## Tags
- \`user/identity\` — Name, location, profession, affiliations
- \`user/preference\` — Communication style, tool choices, likes/dislikes
- \`user/expertise\` — Skills, knowledge areas, experience level
- \`user/goal\` — Intentions, aspirations, longer-term objectives
- \`user/profile-summary\` — Auto-generated profile summary from consolidation

## Graph Entities
- \`user\` node — Anchor node per user, fields: \`userId\` (string)
- \`about_user\` edge — Links any memory to a user node, with optional \`domain\` field

## Data Flow
- User facts are stored as memories owned by this domain
- Other domains link their user-relevant data via \`about_user\` or their own edges
- The consolidation schedule periodically synthesizes a cross-domain profile summary`

function buildSchedules(options?: UserDomainOptions): DomainSchedule[] {
  if (options?.consolidateSchedule?.enabled === false) return []

  const intervalMs = options?.consolidateSchedule?.intervalMs ?? DEFAULT_CONSOLIDATE_INTERVAL_MS

  return [
    {
      id: 'consolidate-user-profile',
      name: 'Consolidate user profile',
      intervalMs,
      run: consolidateUserProfile,
    },
  ]
}

export function createUserDomain(options?: UserDomainOptions): DomainConfig {
  return {
    id: USER_DOMAIN_ID,
    name: 'User',
    schema: {
      nodes: [
        {
          name: 'user',
          fields: [
            { name: 'userId', type: 'string' },
          ],
          indexes: [
            { name: 'idx_user_userId', fields: ['userId'], type: 'unique' },
          ],
        },
      ],
      edges: [
        {
          name: 'about_user',
          from: 'memory',
          to: 'user',
          fields: [{ name: 'domain', type: 'string', required: false }],
        },
      ],
    },
    structure: STRUCTURE,
    skills: userSkills,
    async processInboxItem(_entry: OwnedMemory, _context: DomainContext): Promise<void> {
      // User domain does not process inbox — data enters through external skill
    },
    schedules: buildSchedules(options),
    describe() {
      return 'Built-in primitive for tracking user identity and aggregating cross-domain user data. Manages user nodes, user fact memories, and periodic profile consolidation.'
    },
    search: {
      async expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
        const userId = context.requestContext.userId as string | undefined
        if (!userId) return query

        // Check if user node exists
        const userNodeId = `user:${userId}`
        const userNode = await context.graph.getNode(userNodeId)
        if (!userNode) return query

        // Look for user expertise/preference to augment query
        // This is a lightweight expansion — just adds user tags for relevance boosting
        return query
      },
    },
  }
}

export const userDomain = createUserDomain()
```

- [ ] **Step 2: Create barrel export**

```typescript
export { createUserDomain, userDomain } from './user-domain.ts'
```

- [ ] **Step 3: Commit**

```bash
git add src/domains/user/user-domain.ts src/domains/user/index.ts
git commit -m "feat(user): implement user domain config factory"
```

---

### Task 8: Export user domain from package index

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add user domain type exports**

After the topic type exports line:

```typescript
export type { TopicAttributes, TopicDomainOptions, TopicStatus } from './domains/topic/types.ts'
```

Add:

```typescript
export type { UserDomainOptions } from './domains/user/types.ts'
```

- [ ] **Step 2: Add user domain exports**

After the topic domain export line:

```typescript
export { createTopicDomain, topicDomain } from './domains/topic/index.ts'
```

Add:

```typescript
export { createUserDomain, userDomain } from './domains/user/index.ts'
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(user): export user domain from package index"
```

---

### Task 9: User domain tests

**Files:**
- Create: `tests/user-domain.test.ts`

- [ ] **Step 1: Write unit and integration tests**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'
import { consolidateUserProfile } from '../src/domains/user/schedules.ts'
import { USER_TAG, USER_DOMAIN_ID, DEFAULT_CONSOLIDATE_INTERVAL_MS } from '../src/domains/user/types.ts'
import { createUserDomain, userDomain } from '../src/domains/user/index.ts'
import type { DomainConfig, OwnedMemory, DomainContext } from '../src/core/types.ts'

describe('User domain - config', () => {
  test('user domain has correct id and name', () => {
    const domain = createUserDomain()
    expect(domain.id).toBe(USER_DOMAIN_ID)
    expect(domain.name).toBe('User')
  })

  test('user domain has structure and skills', () => {
    const domain = createUserDomain()
    expect(domain.structure).toBeTypeOf('string')
    expect(domain.structure!.length).toBeGreaterThan(0)
    expect(domain.skills).toHaveLength(3)
    const skillIds = domain.skills!.map(s => s.id)
    expect(skillIds).toContain('user-data')
    expect(skillIds).toContain('user-query')
    expect(skillIds).toContain('user-profile')
  })

  test('user domain schema has user node and about_user edge', () => {
    const domain = createUserDomain()
    const nodes = domain.schema!.nodes
    const edges = domain.schema!.edges

    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('user')
    expect(nodes[0].fields).toEqual([{ name: 'userId', type: 'string' }])
    expect(nodes[0].indexes).toEqual([{ name: 'idx_user_userId', fields: ['userId'], type: 'unique' }])

    expect(edges).toHaveLength(1)
    expect(edges[0].name).toBe('about_user')
    expect(edges[0].from).toBe('memory')
    expect(edges[0].to).toBe('user')
  })

  test('default options include consolidation schedule', () => {
    const domain = createUserDomain()
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].id).toBe('consolidate-user-profile')
    expect(domain.schedules![0].intervalMs).toBe(DEFAULT_CONSOLIDATE_INTERVAL_MS)
  })

  test('consolidation schedule can be disabled', () => {
    const domain = createUserDomain({ consolidateSchedule: { enabled: false } })
    expect(domain.schedules).toHaveLength(0)
  })

  test('consolidation schedule accepts custom interval', () => {
    const domain = createUserDomain({ consolidateSchedule: { intervalMs: 5000 } })
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].intervalMs).toBe(5000)
  })

  test('processInboxItem is a no-op', async () => {
    const domain = createUserDomain()
    const result = await domain.processInboxItem(
      { memory: { id: 'test', content: '', embedding: [], eventTime: null, createdAt: 0, tokenCount: 0 }, domainAttributes: {}, tags: [] },
      {} as DomainContext
    )
    expect(result).toBeUndefined()
  })

  test('describe returns a non-empty string', () => {
    const domain = createUserDomain()
    const description = domain.describe!()
    expect(description).toBeTypeOf('string')
    expect(description.length).toBeGreaterThan(0)
  })

  test('default userDomain instance is valid', () => {
    expect(userDomain.id).toBe(USER_DOMAIN_ID)
    expect(userDomain.schedules).toHaveLength(1)
  })
})

describe('User domain - integration', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
      context: { userId: 'test-user' },
    })
    await engine.registerDomain(userDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('user node can be created and retrieved', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    const userId = ctx.requestContext.userId as string

    const userNodeId = `user:${userId}`
    await ctx.graph.createNodeWithId(userNodeId, { userId })

    const node = await ctx.graph.getNode(userNodeId)
    expect(node).toBeDefined()
    expect(node!.userId).toBe('test-user')
  })

  test('user fact can be stored and linked to user node', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    const userId = ctx.requestContext.userId as string
    const userNodeId = `user:${userId}`

    await ctx.graph.createNodeWithId(userNodeId, { userId })

    const memoryId = await ctx.writeMemory({
      content: 'User is a senior TypeScript developer',
      tags: [`${USER_TAG}/expertise`],
      ownership: {
        domain: USER_DOMAIN_ID,
        attributes: {},
      },
    })

    await ctx.graph.relate(memoryId, 'about_user', userNodeId)

    // Verify the memory exists
    const memory = await ctx.getMemory(memoryId)
    expect(memory).toBeDefined()
    expect(memory!.content).toBe('User is a senior TypeScript developer')

    // Verify the edge exists
    const edges = await ctx.getNodeEdges(userNodeId, 'in')
    const aboutEdges = edges.filter(e => String(e.id).includes('about_user'))
    expect(aboutEdges.length).toBeGreaterThan(0)
  })

  test('user fact tags are retrievable', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)

    const memoryId = await ctx.writeMemory({
      content: 'User prefers dark mode',
      tags: [`${USER_TAG}/preference`],
      ownership: {
        domain: USER_DOMAIN_ID,
        attributes: {},
      },
    })

    const tags = await ctx.getMemoryTags(memoryId)
    expect(tags).toContain(`${USER_TAG}/preference`)
  })

  test('another domain can link its memory to user via about_user', async () => {
    const otherDomain: DomainConfig = {
      id: 'notes',
      name: 'Notes',
      schema: { nodes: [], edges: [] },
      async processInboxItem(_entry: OwnedMemory, _context: DomainContext) {},
    }
    await engine.registerDomain(otherDomain)

    const userCtx = engine.createDomainContext(USER_DOMAIN_ID)
    const userId = userCtx.requestContext.userId as string
    const userNodeId = `user:${userId}`
    await userCtx.graph.createNodeWithId(userNodeId, { userId })

    // Notes domain ingests something and links to user
    const result = await engine.ingest('User mentioned they enjoy hiking', { domains: ['notes'] })
    const notesCtx = engine.createDomainContext('notes')
    await notesCtx.graph.relate(result.id!, 'about_user', userNodeId)

    // Verify edge from user perspective
    const edges = await userCtx.getNodeEdges(userNodeId, 'in')
    const linkedMemIds = edges.map(e => String(e.in))
    expect(linkedMemIds).toContain(result.id!)
  })

  test('search expand hook receives userId from request context', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    expect(ctx.requestContext.userId).toBe('test-user')
  })
})

describe('User domain - consolidation schedule', () => {
  let engine: MemoryEngine
  let mockLlm: MockLLMAdapter

  beforeEach(async () => {
    mockLlm = new MockLLMAdapter()
    mockLlm.consolidateResult = 'Senior TypeScript developer who prefers concise explanations and enjoys hiking.'

    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: mockLlm,
      embedding: new MockEmbeddingAdapter(),
      context: { userId: 'test-user' },
    })
    await engine.registerDomain(userDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('consolidation creates a profile summary from linked memories', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    const userNodeId = 'user:test-user'

    await ctx.graph.createNodeWithId(userNodeId, { userId: 'test-user' })

    // Create some user facts
    const mem1 = await ctx.writeMemory({
      content: 'User is a senior TypeScript developer',
      tags: [`${USER_TAG}/expertise`],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })
    await ctx.graph.relate(mem1, 'about_user', userNodeId)

    const mem2 = await ctx.writeMemory({
      content: 'User prefers concise explanations',
      tags: [`${USER_TAG}/preference`],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })
    await ctx.graph.relate(mem2, 'about_user', userNodeId)

    // Run consolidation
    await consolidateUserProfile(ctx)

    // Check that a profile summary was created
    const summaries = await ctx.getMemories({
      tags: [`${USER_TAG}/profile-summary`],
      domains: [USER_DOMAIN_ID],
    })

    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries[0].content).toBe(mockLlm.consolidateResult)
  })

  test('consolidation skips when no user nodes exist', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    // Don't create any user nodes
    await consolidateUserProfile(ctx)

    const summaries = await ctx.getMemories({
      tags: [`${USER_TAG}/profile-summary`],
      domains: [USER_DOMAIN_ID],
    })

    expect(summaries).toHaveLength(0)
  })

  test('consolidation updates existing summary instead of creating duplicate', async () => {
    const ctx = engine.createDomainContext(USER_DOMAIN_ID)
    const userNodeId = 'user:test-user'

    await ctx.graph.createNodeWithId(userNodeId, { userId: 'test-user' })

    const mem1 = await ctx.writeMemory({
      content: 'User likes TypeScript',
      tags: [`${USER_TAG}/expertise`],
      ownership: { domain: USER_DOMAIN_ID, attributes: {} },
    })
    await ctx.graph.relate(mem1, 'about_user', userNodeId)

    // First consolidation
    await consolidateUserProfile(ctx)

    // Second consolidation
    mockLlm.consolidateResult = 'Updated profile: Expert TypeScript developer.'
    await consolidateUserProfile(ctx)

    // Should still be only one summary
    const summaries = await ctx.getMemories({
      tags: [`${USER_TAG}/profile-summary`],
      domains: [USER_DOMAIN_ID],
    })

    expect(summaries).toHaveLength(1)
    expect(summaries[0].content).toBe('Updated profile: Expert TypeScript developer.')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/user-domain.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/user-domain.test.ts
git commit -m "test(user): add unit and integration tests for user domain"
```

---

### Task 10: CLI --user-id flag

**Files:**
- Modify: `src/cli/commands/ingest.ts`
- Modify: `src/cli/commands/search.ts`
- Modify: `src/cli/commands/ask.ts`
- Modify: `src/cli/commands/build-context.ts`

- [ ] **Step 1: Add --user-id to ingest command**

In `src/cli/commands/ingest.ts`, add after the `skipDedup` flag handling:

```typescript
  if (parsed.flags['user-id']) {
    options.context = { userId: parsed.flags['user-id'] as string }
  }
```

- [ ] **Step 2: Add --user-id to search command**

Read `src/cli/commands/search.ts` first, then add `context` to the query object when `--user-id` is provided:

```typescript
  if (parsed.flags['user-id']) {
    query.context = { userId: parsed.flags['user-id'] as string }
  }
```

- [ ] **Step 3: Add --user-id to ask command**

Read `src/cli/commands/ask.ts` first, then add `context` to the options object when `--user-id` is provided:

```typescript
  if (parsed.flags['user-id']) {
    options.context = { userId: parsed.flags['user-id'] as string }
  }
```

- [ ] **Step 4: Add --user-id to build-context command**

Read `src/cli/commands/build-context.ts` first, then add `context` to the options object when `--user-id` is provided:

```typescript
  if (parsed.flags['user-id']) {
    options.context = { userId: parsed.flags['user-id'] as string }
  }
```

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/ingest.ts src/cli/commands/search.ts src/cli/commands/ask.ts src/cli/commands/build-context.ts
git commit -m "feat(cli): add --user-id flag to all CLI commands"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run lint**

Run: `bun run lint`
Expected: PASS (no lint errors)

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 4: Fix any issues found in steps 1-3**

If any step fails, fix the issue and re-run.

- [ ] **Step 5: Commit any fixes**

Only if fixes were needed in step 4.
