# Chat Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a built-in conversational memory domain with tiered lifecycle (working → episodic → semantic), ported from AiMemory patterns.

**Architecture:** The Chat domain is a standard `DomainConfig` following the Topic/User domain pattern. It processes inbox items (storing raw messages as working memory with topic extraction), runs three schedules (promote, consolidate, prune), and enforces strict user isolation on all operations. It depends on Topic and User domains via their external skills.

**Tech Stack:** TypeScript, SurrealDB (in-memory for tests), bun:test

**Spec:** `docs/superpowers/specs/2026-03-31-chat-domain-design.md`

---

## File Structure

```
src/domains/chat/
├── types.ts              # ChatDomainOptions, ChatAttributes, constants
├── chat-domain.ts        # createChatDomain(), chatDomain export, schema, skills, schedules
├── inbox.ts              # processInboxItem implementation (store + topic extraction)
├── schedules.ts          # promote, consolidate, prune schedule implementations
├── skills.ts             # DomainSkill[] definitions
├── structure.md          # Domain data structure documentation
├── index.ts              # Public exports
└── skills/
    ├── chat-ingest.md    # External skill: how to feed messages
    ├── chat-query.md     # External skill: how to retrieve context
    └── chat-processing.md # Internal skill: schedule documentation

tests/
└── chat-domain.test.ts   # Config, integration, inbox, and schedule tests
```

---

### Task 1: Types and Constants

**Files:**
- Create: `src/domains/chat/types.ts`

- [ ] **Step 1: Create types file**

```typescript
export type ChatLayer = 'working' | 'episodic' | 'semantic'
export type ChatRole = 'user' | 'assistant'

export interface ChatAttributes {
  role: ChatRole
  layer: ChatLayer
  chatSessionId: string
  userId: string
  messageIndex: number
  weight?: number
}

export interface ChatDomainOptions {
  workingMemoryCapacity?: number
  workingMemoryMaxAge?: number
  promoteSchedule?: {
    enabled?: boolean
    intervalMs?: number
  }
  consolidateSchedule?: {
    enabled?: boolean
    intervalMs?: number
  }
  pruneSchedule?: {
    enabled?: boolean
    intervalMs?: number
  }
  decay?: {
    episodicLambda?: number
    semanticLambda?: number
    pruneThreshold?: number
  }
  consolidation?: {
    similarityThreshold?: number
    minClusterSize?: number
  }
}

export const CHAT_DOMAIN_ID = 'chat'
export const CHAT_TAG = 'chat'
export const CHAT_MESSAGE_TAG = 'chat/message'
export const CHAT_EPISODIC_TAG = 'chat/episodic'
export const CHAT_SEMANTIC_TAG = 'chat/semantic'

export const DEFAULT_WORKING_CAPACITY = 50
export const DEFAULT_WORKING_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours
export const DEFAULT_PROMOTE_INTERVAL_MS = 1_800_000 // 30 minutes
export const DEFAULT_CONSOLIDATE_INTERVAL_MS = 3_600_000 // 1 hour
export const DEFAULT_PRUNE_INTERVAL_MS = 3_600_000 // 1 hour
export const DEFAULT_EPISODIC_LAMBDA = 0.01
export const DEFAULT_SEMANTIC_LAMBDA = 0.001
export const DEFAULT_PRUNE_THRESHOLD = 0.05
export const DEFAULT_CONSOLIDATION_SIMILARITY = 0.7
export const DEFAULT_CONSOLIDATION_MIN_CLUSTER = 3
```

- [ ] **Step 2: Verify types compile**

Run: `bun tsc --noEmit src/domains/chat/types.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/domains/chat/types.ts
git commit -m "feat(chat): add types and constants for chat domain"
```

---

### Task 2: Skills Definitions

**Files:**
- Create: `src/domains/chat/skills.ts`

- [ ] **Step 1: Create skills file**

```typescript
import type { DomainSkill } from '../../core/types.ts'

const chatIngest: DomainSkill = {
  id: 'chat-ingest',
  name: 'How to feed messages into the chat domain',
  description: 'Tells external agents how to ingest user and assistant messages, including required request context (userId, chatSessionId) and message format',
  scope: 'external',
}

const chatQuery: DomainSkill = {
  id: 'chat-query',
  name: 'How to retrieve conversational memory',
  description: 'Tells external agents how to use buildContext for assembling tiered conversation history with depth-based budget allocation',
  scope: 'external',
}

const chatProcessing: DomainSkill = {
  id: 'chat-processing',
  name: 'Internal chat processing schedules',
  description: 'Documents the promotion, consolidation, and pruning schedules that manage the working → episodic → semantic lifecycle',
  scope: 'internal',
}

export const chatSkills: DomainSkill[] = [chatIngest, chatQuery, chatProcessing]
```

- [ ] **Step 2: Commit**

```bash
git add src/domains/chat/skills.ts
git commit -m "feat(chat): add skill definitions"
```

---

### Task 3: Structure and Skill Markdown Files

**Files:**
- Create: `src/domains/chat/structure.md`
- Create: `src/domains/chat/skills/chat-ingest.md`
- Create: `src/domains/chat/skills/chat-query.md`
- Create: `src/domains/chat/skills/chat-processing.md`

- [ ] **Step 1: Create structure.md**

```markdown
# Chat Domain

Built-in conversational memory with a tiered lifecycle: working → episodic → semantic.

## Tags
- `chat` — Root tag for all chat memories
- `chat/message` — Working layer: raw conversation messages
- `chat/episodic` — Episodic layer: extracted highlights and facts
- `chat/semantic` — Semantic layer: consolidated long-term knowledge

## Ownership Attributes
- `role`: 'user' | 'assistant' — Who produced the message
- `layer`: 'working' | 'episodic' | 'semantic' — Lifecycle tier
- `chatSessionId`: string — Session scope (working layer)
- `userId`: string — Always present; all operations are user-bound
- `messageIndex`: number — Order of appearance in inbox per session
- `weight`: number (0–1) — Importance/decay score (episodic/semantic)

## Edges
- `about_topic`: Links chat memories to topics (reuses Topic domain edge)
- `summarizes`: Links episodic/semantic memories to their source working memories
```

- [ ] **Step 2: Create skills/chat-ingest.md**

```markdown
# Chat Ingestion

Feed messages into the Chat domain by ingesting text with the chat domain as owner. Both user and assistant messages are supported.

## Required Request Context

Every ingestion call must include `userId` and `chatSessionId` in the request context:

```ts
await engine.ingest(messageText, {
  domains: ['chat'],
  context: {
    userId: 'user-123',
    chatSessionId: 'session-456',
  },
})
```

## Message Role

The `role` field distinguishes user input from agent output. Pass it via ingest metadata:

```ts
// User message
await engine.ingest('What is TypeScript?', {
  domains: ['chat'],
  metadata: { role: 'user' },
  context: { userId: 'user-123', chatSessionId: 'session-456' },
})

// Assistant response
await engine.ingest('TypeScript is a typed superset of JavaScript.', {
  domains: ['chat'],
  metadata: { role: 'assistant' },
  context: { userId: 'user-123', chatSessionId: 'session-456' },
})
```

## What Happens on Ingestion

1. The message is stored as working memory with `chat/message` tag
2. Topics are extracted and linked via `about_topic` edges
3. `messageIndex` is auto-incremented per session
4. The raw message is available immediately for context building
```

- [ ] **Step 3: Create skills/chat-query.md**

```markdown
# Chat Querying

Retrieve conversational memory using search and context building.

## Building Context

Use `buildContext` to assemble a token-budgeted context string from all three memory tiers:

```ts
const result = await engine.buildContext(queryText, {
  domains: ['chat'],
  budgetTokens: 4000,
  context: { userId: 'user-123', chatSessionId: 'session-456' },
})
// result.context contains the assembled string
// result.memories lists the memories used
// result.totalTokens is the token count
```

## Context Sections

The assembled context contains three sections:

1. **Recent** — Working memory filtered by `chatSessionId`, ordered by `messageIndex`
2. **Context** — Episodic memory filtered by `userId`, ranked by relevance and recency
3. **Background** — Semantic memory filtered by `userId`, ranked by relevance

## Searching Chat Memories

Use search with domain and tag filters:

```ts
// Find episodic memories for a user
const results = await engine.search({
  text: 'TypeScript',
  domains: ['chat'],
  tags: ['chat/episodic'],
  context: { userId: 'user-123' },
})

// Find all working memories for a session
const session = await engine.search({
  text: '',
  domains: ['chat'],
  tags: ['chat/message'],
  context: { userId: 'user-123', chatSessionId: 'session-456' },
})
```

## Depth Parameter

Context building supports a `depth` parameter that shifts budget allocation:
- Low depth (default): favors working memory (recent conversation)
- High depth: favors semantic/episodic (background knowledge)
```

- [ ] **Step 4: Create skills/chat-processing.md**

```markdown
# Chat Processing (Internal)

Three scheduled tasks manage the working → episodic → semantic lifecycle.

## Promote Working Memory

Finds working memories that exceed capacity or age threshold per user.

1. Collect working memories ordered by `messageIndex`
2. LLM extraction: distill key facts and highlights
3. Create episodic memories (`chat/episodic`) with assigned weight
4. Link episodic → working via `summarizes` edges
5. Extract user-specific facts → push to User domain via `user-data` skill
6. Extract deeper semantic topics → link via `about_topic`
7. Release ownership claims on promoted working memories

## Consolidate Episodic

Clusters episodic memories by embedding similarity per user.

1. Find episodic memories for the user
2. Cluster by cosine similarity (threshold: configurable, default 0.7)
3. For clusters above minimum size: LLM summarizes into semantic memory
4. Link semantic → episodic via `summarizes` edges
5. Release ownership claims on consolidated episodic memories

## Prune Decayed

Removes episodic memories whose weight has decayed below threshold.

1. Calculate decayed weight: `weight * e^(-lambda * hoursSinceCreation)`
2. Release ownership claims on memories below prune threshold

## Decay Formula

```
decayedWeight = weight * Math.exp(-lambda * hoursSinceCreation)
```

- Episodic lambda: 0.01 (default) — decays to ~50% in ~69 hours
- Semantic lambda: 0.001 (default) — decays to ~50% in ~693 hours
- Prune threshold: 0.05 (default) — released when weight drops below this
```

- [ ] **Step 5: Commit**

```bash
git add src/domains/chat/structure.md src/domains/chat/skills/
git commit -m "feat(chat): add structure and skill markdown files"
```

---

### Task 4: Config Tests

**Files:**
- Create: `tests/chat-domain.test.ts`
- Reference: `tests/helpers.ts`, `tests/topic-domain.test.ts` (pattern)

- [ ] **Step 1: Write config tests**

```typescript
import { describe, test, expect } from 'bun:test'
import { createChatDomain, chatDomain } from '../src/domains/chat/index.ts'
import {
  CHAT_DOMAIN_ID,
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  DEFAULT_PRUNE_INTERVAL_MS,
} from '../src/domains/chat/types.ts'
import type { DomainContext, OwnedMemory } from '../src/core/types.ts'

describe('Chat domain - config', () => {
  test('has correct id and name', () => {
    const domain = createChatDomain()
    expect(domain.id).toBe('chat')
    expect(domain.name).toBe('Chat')
  })

  test('has baseDir and 3 skills', () => {
    const domain = createChatDomain()
    expect(domain.baseDir).toBeTypeOf('string')
    expect(domain.baseDir!.length).toBeGreaterThan(0)
    expect(domain.skills).toHaveLength(3)
    const skillIds = domain.skills!.map(s => s.id)
    expect(skillIds).toContain('chat-ingest')
    expect(skillIds).toContain('chat-query')
    expect(skillIds).toContain('chat-processing')
  })

  test('schema has 1 edge (summarizes)', () => {
    const domain = createChatDomain()
    const edges = domain.schema!.edges
    expect(edges).toHaveLength(1)
    expect(edges[0].name).toBe('summarizes')
    expect(edges[0].from).toBe('memory')
    expect(edges[0].to).toBe('memory')
  })

  test('default options include all three schedules', () => {
    const domain = createChatDomain()
    expect(domain.schedules).toHaveLength(3)
    const scheduleIds = domain.schedules!.map(s => s.id)
    expect(scheduleIds).toContain('promote-working-memory')
    expect(scheduleIds).toContain('consolidate-episodic')
    expect(scheduleIds).toContain('prune-decayed')
  })

  test('schedules use default intervals', () => {
    const domain = createChatDomain()
    const promote = domain.schedules!.find(s => s.id === 'promote-working-memory')!
    const consolidate = domain.schedules!.find(s => s.id === 'consolidate-episodic')!
    const prune = domain.schedules!.find(s => s.id === 'prune-decayed')!
    expect(promote.intervalMs).toBe(DEFAULT_PROMOTE_INTERVAL_MS)
    expect(consolidate.intervalMs).toBe(DEFAULT_CONSOLIDATE_INTERVAL_MS)
    expect(prune.intervalMs).toBe(DEFAULT_PRUNE_INTERVAL_MS)
  })

  test('individual schedules can be disabled', () => {
    const domain = createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
    })
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].id).toBe('prune-decayed')
  })

  test('schedules accept custom intervals', () => {
    const domain = createChatDomain({
      promoteSchedule: { intervalMs: 5000 },
    })
    const promote = domain.schedules!.find(s => s.id === 'promote-working-memory')!
    expect(promote.intervalMs).toBe(5000)
  })

  test('describe() returns a non-empty string', () => {
    const domain = createChatDomain()
    expect(domain.describe).toBeTypeOf('function')
    expect(domain.describe!().length).toBeGreaterThan(0)
  })

  test('default chatDomain instance is valid', () => {
    expect(chatDomain.id).toBe(CHAT_DOMAIN_ID)
    expect(chatDomain.schedules).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts`
Expected: FAIL — `../src/domains/chat/index.ts` does not exist yet

- [ ] **Step 3: Commit**

```bash
git add tests/chat-domain.test.ts
git commit -m "test(chat): add config tests for chat domain"
```

---

### Task 5: Domain Config and Index (make config tests pass)

**Files:**
- Create: `src/domains/chat/chat-domain.ts`
- Create: `src/domains/chat/index.ts`

- [ ] **Step 1: Create chat-domain.ts**

```typescript
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import type { DomainConfig, DomainSchedule, SearchQuery, DomainContext } from '../../core/types.ts'
import {
  CHAT_DOMAIN_ID,
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  DEFAULT_PRUNE_INTERVAL_MS,
} from './types.ts'
import type { ChatDomainOptions } from './types.ts'
import { chatSkills } from './skills.ts'
import { processInboxItem } from './inbox.ts'
import { promoteWorkingMemory, consolidateEpisodic, pruneDecayed } from './schedules.ts'

function buildSchedules(options?: ChatDomainOptions): DomainSchedule[] {
  const schedules: DomainSchedule[] = []

  if (options?.promoteSchedule?.enabled !== false) {
    schedules.push({
      id: 'promote-working-memory',
      name: 'Promote working memory',
      intervalMs: options?.promoteSchedule?.intervalMs ?? DEFAULT_PROMOTE_INTERVAL_MS,
      run: (context: DomainContext) => promoteWorkingMemory(context, options),
    })
  }

  if (options?.consolidateSchedule?.enabled !== false) {
    schedules.push({
      id: 'consolidate-episodic',
      name: 'Consolidate episodic memory',
      intervalMs: options?.consolidateSchedule?.intervalMs ?? DEFAULT_CONSOLIDATE_INTERVAL_MS,
      run: (context: DomainContext) => consolidateEpisodic(context, options),
    })
  }

  if (options?.pruneSchedule?.enabled !== false) {
    schedules.push({
      id: 'prune-decayed',
      name: 'Prune decayed memories',
      intervalMs: options?.pruneSchedule?.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS,
      run: (context: DomainContext) => pruneDecayed(context, options),
    })
  }

  return schedules
}

export function createChatDomain(options?: ChatDomainOptions): DomainConfig {
  return {
    id: CHAT_DOMAIN_ID,
    name: 'Chat',
    baseDir: dirname(fileURLToPath(import.meta.url)),
    schema: {
      nodes: [],
      edges: [
        { name: 'summarizes', from: 'memory', to: 'memory' },
      ],
    },
    skills: chatSkills,
    processInboxItem,
    schedules: buildSchedules(options),
    describe() {
      return 'Built-in conversational memory with tiered lifecycle. Stores raw messages as working memory, extracts highlights into episodic memory, and consolidates long-term knowledge into semantic memory.'
    },
    search: {
      async expand(query: SearchQuery, context: DomainContext): Promise<SearchQuery> {
        const userId = context.requestContext.userId as string | undefined
        if (!userId) {
          return { ...query, ids: [] }
        }
        return query
      },
    },
  }
}

export const chatDomain = createChatDomain()
```

- [ ] **Step 2: Create stub inbox.ts** (to satisfy import, real implementation in Task 6)

```typescript
import type { OwnedMemory, DomainContext } from '../../core/types.ts'

export async function processInboxItem(_entry: OwnedMemory, _context: DomainContext): Promise<void> {
  // Stub — implemented in Task 6
}
```

- [ ] **Step 3: Create stub schedules.ts** (to satisfy import, real implementation in Tasks 8-10)

```typescript
import type { DomainContext } from '../../core/types.ts'
import type { ChatDomainOptions } from './types.ts'

export async function promoteWorkingMemory(_context: DomainContext, _options?: ChatDomainOptions): Promise<void> {
  // Stub — implemented in Task 8
}

export async function consolidateEpisodic(_context: DomainContext, _options?: ChatDomainOptions): Promise<void> {
  // Stub — implemented in Task 9
}

export async function pruneDecayed(_context: DomainContext, _options?: ChatDomainOptions): Promise<void> {
  // Stub — implemented in Task 10
}
```

- [ ] **Step 4: Create index.ts**

```typescript
export { createChatDomain, chatDomain } from './chat-domain.ts'
```

- [ ] **Step 5: Run config tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts`
Expected: All config tests PASS

- [ ] **Step 6: Run full test suite to check nothing is broken**

Run: `bun test`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add src/domains/chat/
git commit -m "feat(chat): add domain config, stubs for inbox and schedules"
```

---

### Task 6: Inbox Processing Implementation

**Files:**
- Modify: `src/domains/chat/inbox.ts`
- Reference: `src/domains/topic/skills/topic-management.md` (topic creation pattern)

- [ ] **Step 1: Write inbox processing tests**

Add to `tests/chat-domain.test.ts`:

```typescript
import { beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'
import { createChatDomain, chatDomain } from '../src/domains/chat/index.ts'
import { createTopicDomain } from '../src/domains/topic/index.ts'
import {
  CHAT_DOMAIN_ID,
  CHAT_TAG,
  CHAT_MESSAGE_TAG,
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  DEFAULT_PRUNE_INTERVAL_MS,
} from '../src/domains/chat/types.ts'
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from '../src/domains/topic/types.ts'
import type { DomainContext, OwnedMemory } from '../src/core/types.ts'

describe('Chat domain - inbox processing', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    llm.extractResult = ['TypeScript']
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user', chatSessionId: 'session-1' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }))
    await engine.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))
  })

  afterEach(async () => {
    await engine.close()
  })

  test('inbox processing stores message as working memory with correct attributes', async () => {
    await engine.ingest('What is TypeScript?', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] })
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe('What is TypeScript?')
  })

  test('inbox processing assigns userId and chatSessionId from request context', async () => {
    await engine.ingest('Hello', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const results = await ctx.search({ text: 'Hello', tags: [CHAT_MESSAGE_TAG] })
    const entry = results.entries[0]
    const attrs = entry.domainAttributes[CHAT_DOMAIN_ID]
    expect(attrs.userId).toBe('test-user')
    expect(attrs.chatSessionId).toBe('session-1')
    expect(attrs.role).toBe('user')
    expect(attrs.layer).toBe('working')
    expect(typeof attrs.messageIndex).toBe('number')
  })

  test('inbox processing auto-increments messageIndex per session', async () => {
    await engine.ingest('First message', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    await engine.ingest('Second message', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'assistant' },
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] })
    const sorted = memories.sort((a, b) => a.createdAt - b.createdAt)

    const results = await ctx.search({ text: 'First message Second message', tags: [CHAT_MESSAGE_TAG] })
    const first = results.entries.find(e => e.content === 'First message')
    const second = results.entries.find(e => e.content === 'Second message')

    expect(first!.domainAttributes[CHAT_DOMAIN_ID].messageIndex).toBeLessThan(
      second!.domainAttributes[CHAT_DOMAIN_ID].messageIndex
    )
  })

  test('inbox processing skips when userId is missing', async () => {
    const engineNoUser = new MemoryEngine()
    await engineNoUser.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_nouser_${Date.now()}`,
      context: { chatSessionId: 'session-1' },
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
    })
    await engineNoUser.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))

    await engineNoUser.ingest('Hello', { domains: [CHAT_DOMAIN_ID], metadata: { role: 'user' } })
    await engineNoUser.processInbox()

    const ctx = engineNoUser.createDomainContext(CHAT_DOMAIN_ID)
    const memories = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] })
    expect(memories).toHaveLength(0)
    await engineNoUser.close()
  })

  test('inbox processing extracts and links topics', async () => {
    llm.extractResult = ['TypeScript programming']
    await engine.ingest('I love working with TypeScript programming', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const topics = await ctx.getMemories({ tags: [TOPIC_TAG] })
    expect(topics.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts`
Expected: FAIL — inbox processing is a stub

- [ ] **Step 3: Implement inbox processing**

Replace `src/domains/chat/inbox.ts`:

```typescript
import type { OwnedMemory, DomainContext } from '../../core/types.ts'
import { CHAT_DOMAIN_ID, CHAT_TAG, CHAT_MESSAGE_TAG } from './types.ts'
import { TOPIC_TAG, TOPIC_DOMAIN_ID } from '../topic/types.ts'

export async function processInboxItem(entry: OwnedMemory, context: DomainContext): Promise<void> {
  const userId = context.requestContext.userId as string | undefined
  const chatSessionId = context.requestContext.chatSessionId as string | undefined

  if (!userId || !chatSessionId) return

  const role = (entry.domainAttributes.role as string) ?? 'user'

  // Determine messageIndex: count existing working memories for this session
  const existing = await context.getMemories({
    tags: [CHAT_MESSAGE_TAG],
    attributes: { chatSessionId, userId },
  })
  const messageIndex = existing.length

  // Update ownership attributes on the memory
  await context.updateAttributes(entry.memory.id, {
    role,
    layer: 'working',
    chatSessionId,
    userId,
    messageIndex,
  })

  // Add chat tags
  await context.tagMemory(entry.memory.id, CHAT_TAG)
  await context.tagMemory(entry.memory.id, CHAT_MESSAGE_TAG)

  // Topic extraction
  await extractAndLinkTopics(entry.memory.content, entry.memory.id, context)
}

async function extractAndLinkTopics(
  content: string,
  memoryId: string,
  context: DomainContext
): Promise<void> {
  const topicNames = await context.llm.extract(content)
  if (!topicNames || topicNames.length === 0) return

  for (const topicName of topicNames) {
    if (!topicName.trim()) continue

    // Search for existing similar topic
    const searchResult = await context.search({
      text: topicName,
      tags: [TOPIC_TAG],
      minScore: 0.8,
    })

    let topicId: string

    if (searchResult.entries.length > 0) {
      // Use existing topic — increment mention count
      topicId = searchResult.entries[0].id
      const attrs = searchResult.entries[0].domainAttributes[TOPIC_DOMAIN_ID]
      const currentCount = typeof attrs?.mentionCount === 'number' ? attrs.mentionCount : 0
      await context.updateAttributes(topicId, {
        ...attrs,
        mentionCount: currentCount + 1,
        lastMentionedAt: Date.now(),
      })
    } else {
      // Create new topic via Topic domain conventions
      topicId = await context.writeMemory({
        content: topicName,
        tags: [TOPIC_TAG],
        ownership: {
          domain: TOPIC_DOMAIN_ID,
          attributes: {
            name: topicName,
            status: 'active',
            mentionCount: 1,
            lastMentionedAt: Date.now(),
            createdBy: CHAT_DOMAIN_ID,
          },
        },
      })
    }

    // Link this message to the topic
    await context.graph.relate(memoryId, 'about_topic', topicId, {
      domain: CHAT_DOMAIN_ID,
    })
  }
}
```

- [ ] **Step 4: Run inbox tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts`
Expected: All inbox tests PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Run lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/domains/chat/inbox.ts tests/chat-domain.test.ts
git commit -m "feat(chat): implement inbox processing with topic extraction"
```

---

### Task 7: Search Expansion Tests

**Files:**
- Modify: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write search expansion tests**

Add to `tests/chat-domain.test.ts`:

```typescript
describe('Chat domain - search', () => {
  let engine: MemoryEngine

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user', chatSessionId: 'session-1' },
      llm: new MockLLMAdapter(),
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))
  })

  afterEach(async () => {
    await engine.close()
  })

  test('search.expand returns empty when userId is missing', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const domain = createChatDomain()
    const result = await domain.search!.expand!(
      { text: 'test' },
      { ...ctx, requestContext: {} } as DomainContext
    )
    expect(result.ids).toEqual([])
  })

  test('search.expand passes through query when userId is present', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    const domain = createChatDomain()
    const query = { text: 'test', tags: ['chat'] }
    const result = await domain.search!.expand!(query, ctx)
    expect(result).toEqual(query)
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts`
Expected: PASS (search.expand is already implemented in chat-domain.ts)

- [ ] **Step 3: Commit**

```bash
git add tests/chat-domain.test.ts
git commit -m "test(chat): add search expansion tests"
```

---

### Task 8: Promote Working Memory Schedule

**Files:**
- Modify: `src/domains/chat/schedules.ts`
- Modify: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write promotion schedule tests**

Add to `tests/chat-domain.test.ts`:

```typescript
import { promoteWorkingMemory } from '../src/domains/chat/schedules.ts'
import { CHAT_EPISODIC_TAG } from '../src/domains/chat/types.ts'

describe('Chat domain - promote schedule', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    llm.extractResult = ['TypeScript']
    llm.consolidateResult = 'User discussed TypeScript programming'
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user', chatSessionId: 'session-1' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }))
    await engine.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))
  })

  afterEach(async () => {
    await engine.close()
  })

  test('promotes working memories when capacity exceeded', async () => {
    // Ingest enough messages to exceed capacity (set low for test)
    for (let i = 0; i < 3; i++) {
      await engine.ingest(`Message ${i}`, {
        domains: [CHAT_DOMAIN_ID],
        metadata: { role: 'user' },
      })
      await engine.processInbox()
    }

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    llm.extractResult = ['Key fact from conversation']

    await promoteWorkingMemory(ctx, { workingMemoryCapacity: 2 })

    // Should have created episodic memories
    const episodic = await ctx.getMemories({ tags: [CHAT_EPISODIC_TAG] })
    expect(episodic.length).toBeGreaterThan(0)
  })

  test('skips promotion when under capacity', async () => {
    await engine.ingest('Single message', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    await promoteWorkingMemory(ctx, { workingMemoryCapacity: 50 })

    const episodic = await ctx.getMemories({ tags: [CHAT_EPISODIC_TAG] })
    expect(episodic).toHaveLength(0)
  })

  test('released working memories are no longer owned by chat domain', async () => {
    for (let i = 0; i < 3; i++) {
      await engine.ingest(`Message ${i}`, {
        domains: [CHAT_DOMAIN_ID],
        metadata: { role: 'user' },
      })
      await engine.processInbox()
    }

    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    llm.extractResult = ['Extracted fact']

    const beforeWorking = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] })
    expect(beforeWorking.length).toBe(3)

    await promoteWorkingMemory(ctx, { workingMemoryCapacity: 2 })

    // At least some working memories should have been released
    const afterWorking = await ctx.getMemories({ tags: [CHAT_MESSAGE_TAG] })
    expect(afterWorking.length).toBeLessThan(beforeWorking.length)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts`
Expected: FAIL — promoteWorkingMemory is a stub

- [ ] **Step 3: Implement promoteWorkingMemory**

Update `src/domains/chat/schedules.ts` — replace the `promoteWorkingMemory` stub:

```typescript
import type { DomainContext } from '../../core/types.ts'
import type { ChatDomainOptions } from './types.ts'
import {
  CHAT_DOMAIN_ID,
  CHAT_TAG,
  CHAT_MESSAGE_TAG,
  CHAT_EPISODIC_TAG,
  DEFAULT_WORKING_CAPACITY,
  DEFAULT_WORKING_MAX_AGE,
} from './types.ts'

export async function promoteWorkingMemory(context: DomainContext, options?: ChatDomainOptions): Promise<void> {
  const capacity = options?.workingMemoryCapacity ?? DEFAULT_WORKING_CAPACITY
  const maxAge = options?.workingMemoryMaxAge ?? DEFAULT_WORKING_MAX_AGE
  const now = Date.now()

  // Get all working memories grouped by userId+session
  const workingMemories = await context.getMemories({
    tags: [CHAT_MESSAGE_TAG],
    attributes: { layer: 'working' },
  })

  if (workingMemories.length === 0) return

  // Group by userId+chatSessionId
  const sessionGroups = new Map<string, typeof workingMemories>()
  for (const mem of workingMemories) {
    // Retrieve attributes from search to get userId/chatSessionId
    const searchResult = await context.search({
      text: mem.content,
      ids: [mem.id],
    })
    const entry = searchResult.entries.find(e => e.id === mem.id)
    const attrs = entry?.domainAttributes[CHAT_DOMAIN_ID]
    if (!attrs?.userId || !attrs?.chatSessionId) continue

    const key = `${attrs.userId}:${attrs.chatSessionId}`
    const group = sessionGroups.get(key) ?? []
    group.push(mem)
    sessionGroups.set(key, group)
  }

  for (const [_key, memories] of sessionGroups) {
    // Sort by messageIndex (via createdAt as proxy)
    const sorted = memories.sort((a, b) => a.createdAt - b.createdAt)

    // Determine which memories to promote: excess capacity or aged out
    const toPromote = sorted.filter((mem, index) => {
      const overCapacity = sorted.length - index > capacity
      const overAge = (now - mem.createdAt) > maxAge
      return overCapacity || overAge
    })

    if (toPromote.length === 0) continue

    // Collect content for LLM extraction
    const contents = toPromote.map(m => m.content)
    const extracted = await context.llm.extract(contents.join('\n'))

    if (extracted && extracted.length > 0) {
      for (const fact of extracted) {
        if (!fact.trim()) continue

        // Create episodic memory
        const episodicId = await context.writeMemory({
          content: fact,
          tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
          ownership: {
            domain: CHAT_DOMAIN_ID,
            attributes: {
              layer: 'episodic',
              userId: (context.requestContext.userId as string) ?? '',
              weight: 0.5,
            },
          },
        })

        // Link episodic → source working memories via summarizes
        for (const source of toPromote) {
          await context.graph.relate(episodicId, 'summarizes', source.id)
        }
      }
    }

    // Release ownership of promoted working memories
    for (const mem of toPromote) {
      await context.releaseOwnership(mem.id, CHAT_DOMAIN_ID)
    }
  }
}
```

Keep the existing stubs for `consolidateEpisodic` and `pruneDecayed` below.

- [ ] **Step 4: Run promotion tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts`
Expected: Promotion tests PASS

- [ ] **Step 5: Run lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/domains/chat/schedules.ts tests/chat-domain.test.ts
git commit -m "feat(chat): implement working memory promotion schedule"
```

---

### Task 9: Consolidate Episodic Schedule

**Files:**
- Modify: `src/domains/chat/schedules.ts`
- Modify: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write consolidation tests**

Add to `tests/chat-domain.test.ts`:

```typescript
import { consolidateEpisodic } from '../src/domains/chat/schedules.ts'
import { CHAT_SEMANTIC_TAG } from '../src/domains/chat/types.ts'

describe('Chat domain - consolidate schedule', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    llm.consolidateResult = 'User is learning TypeScript for web development'
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))
  })

  afterEach(async () => {
    await engine.close()
  })

  test('consolidates clustered episodic memories into semantic', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)

    // Create episodic memories with similar content (will cluster together)
    for (let i = 0; i < 3; i++) {
      await ctx.writeMemory({
        content: `TypeScript programming fact ${i}`,
        tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
        ownership: {
          domain: CHAT_DOMAIN_ID,
          attributes: { layer: 'episodic', userId: 'test-user', weight: 0.5 },
        },
      })
    }

    await consolidateEpisodic(ctx, {
      consolidation: { similarityThreshold: 0.5, minClusterSize: 2 },
    })

    const semantic = await ctx.getMemories({ tags: [CHAT_SEMANTIC_TAG] })
    expect(semantic.length).toBeGreaterThan(0)
    expect(semantic[0].content).toBe(llm.consolidateResult)
  })

  test('skips consolidation when no episodic memories exist', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)
    await consolidateEpisodic(ctx)

    const semantic = await ctx.getMemories({ tags: [CHAT_SEMANTIC_TAG] })
    expect(semantic).toHaveLength(0)
  })

  test('skips clusters below minimum size', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)

    // Create only 1 episodic memory — below default minClusterSize of 3
    await ctx.writeMemory({
      content: 'Isolated episodic fact',
      tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
      ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: { layer: 'episodic', userId: 'test-user', weight: 0.5 },
      },
    })

    await consolidateEpisodic(ctx)

    const semantic = await ctx.getMemories({ tags: [CHAT_SEMANTIC_TAG] })
    expect(semantic).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts`
Expected: FAIL — consolidateEpisodic is a stub

- [ ] **Step 3: Implement consolidateEpisodic**

Add to `src/domains/chat/schedules.ts`:

```typescript
import {
  DEFAULT_CONSOLIDATION_SIMILARITY,
  DEFAULT_CONSOLIDATION_MIN_CLUSTER,
} from './types.ts'

export async function consolidateEpisodic(context: DomainContext, options?: ChatDomainOptions): Promise<void> {
  const similarityThreshold = options?.consolidation?.similarityThreshold ?? DEFAULT_CONSOLIDATION_SIMILARITY
  const minClusterSize = options?.consolidation?.minClusterSize ?? DEFAULT_CONSOLIDATION_MIN_CLUSTER

  const episodicMemories = await context.getMemories({
    tags: [CHAT_EPISODIC_TAG],
    attributes: { layer: 'episodic' },
  })

  if (episodicMemories.length < minClusterSize) return

  // Cluster by embedding similarity
  const clustered = new Set<string>()
  const clusters: string[][] = []

  for (const mem of episodicMemories) {
    if (clustered.has(mem.id)) continue

    const searchResult = await context.search({
      text: mem.content,
      tags: [CHAT_EPISODIC_TAG],
      minScore: similarityThreshold,
    })

    const cluster = searchResult.entries
      .filter(e => !clustered.has(e.id) && e.domainAttributes[CHAT_DOMAIN_ID]?.layer === 'episodic')
      .map(e => e.id)

    if (cluster.length >= minClusterSize) {
      clusters.push(cluster)
      for (const id of cluster) clustered.add(id)
    }
  }

  for (const cluster of clusters) {
    // Collect content for consolidation
    const contents: string[] = []
    for (const id of cluster) {
      const mem = await context.getMemory(id)
      if (mem) contents.push(mem.content)
    }

    if (contents.length === 0) continue

    const summary = await context.llm.consolidate(contents)
    if (!summary.trim()) continue

    // Create semantic memory
    const semanticId = await context.writeMemory({
      content: summary,
      tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
      ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: {
          layer: 'semantic',
          userId: (context.requestContext.userId as string) ?? '',
          weight: 0.8,
        },
      },
    })

    // Link semantic → episodic via summarizes
    for (const sourceId of cluster) {
      await context.graph.relate(semanticId, 'summarizes', sourceId)
    }

    // Release ownership of consolidated episodic memories
    for (const sourceId of cluster) {
      await context.releaseOwnership(sourceId, CHAT_DOMAIN_ID)
    }
  }
}
```

- [ ] **Step 4: Run consolidation tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts`
Expected: Consolidation tests PASS

- [ ] **Step 5: Run lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/domains/chat/schedules.ts tests/chat-domain.test.ts
git commit -m "feat(chat): implement episodic consolidation schedule"
```

---

### Task 10: Prune Decayed Schedule

**Files:**
- Modify: `src/domains/chat/schedules.ts`
- Modify: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write prune tests**

Add to `tests/chat-domain.test.ts`:

```typescript
import { pruneDecayed } from '../src/domains/chat/schedules.ts'

describe('Chat domain - prune schedule', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))
  })

  afterEach(async () => {
    await engine.close()
  })

  test('prunes episodic memories with weight below threshold', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)

    await ctx.writeMemory({
      content: 'Low weight episodic fact',
      tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
      ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: { layer: 'episodic', userId: 'test-user', weight: 0.01 },
      },
    })

    // Use a high prune threshold to trigger pruning immediately
    await pruneDecayed(ctx, {
      decay: { pruneThreshold: 0.5, episodicLambda: 0.01, semanticLambda: 0.001 },
    })

    const remaining = await ctx.getMemories({ tags: [CHAT_EPISODIC_TAG] })
    expect(remaining).toHaveLength(0)
  })

  test('preserves episodic memories above threshold', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)

    await ctx.writeMemory({
      content: 'High weight episodic fact',
      tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
      ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: { layer: 'episodic', userId: 'test-user', weight: 0.9 },
      },
    })

    await pruneDecayed(ctx, {
      decay: { pruneThreshold: 0.05, episodicLambda: 0.01, semanticLambda: 0.001 },
    })

    const remaining = await ctx.getMemories({ tags: [CHAT_EPISODIC_TAG] })
    expect(remaining).toHaveLength(1)
  })

  test('does not prune semantic memories', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)

    await ctx.writeMemory({
      content: 'Semantic knowledge',
      tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
      ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: { layer: 'semantic', userId: 'test-user', weight: 0.01 },
      },
    })

    await pruneDecayed(ctx, {
      decay: { pruneThreshold: 0.5, episodicLambda: 0.01, semanticLambda: 0.001 },
    })

    const remaining = await ctx.getMemories({ tags: [CHAT_SEMANTIC_TAG] })
    expect(remaining).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts`
Expected: FAIL — pruneDecayed is a stub

- [ ] **Step 3: Implement pruneDecayed**

Add to `src/domains/chat/schedules.ts`:

```typescript
import {
  DEFAULT_EPISODIC_LAMBDA,
  DEFAULT_PRUNE_THRESHOLD,
} from './types.ts'

export async function pruneDecayed(context: DomainContext, options?: ChatDomainOptions): Promise<void> {
  const lambda = options?.decay?.episodicLambda ?? DEFAULT_EPISODIC_LAMBDA
  const threshold = options?.decay?.pruneThreshold ?? DEFAULT_PRUNE_THRESHOLD
  const now = Date.now()

  const episodicMemories = await context.getMemories({
    tags: [CHAT_EPISODIC_TAG],
    attributes: { layer: 'episodic' },
  })

  for (const mem of episodicMemories) {
    const searchResult = await context.search({ text: mem.content, ids: [mem.id] })
    const entry = searchResult.entries.find(e => e.id === mem.id)
    const attrs = entry?.domainAttributes[CHAT_DOMAIN_ID]
    const weight = typeof attrs?.weight === 'number' ? attrs.weight : 0.5

    const hoursSinceCreation = (now - mem.createdAt) / (1000 * 60 * 60)
    const decayedWeight = weight * Math.exp(-lambda * hoursSinceCreation)

    if (decayedWeight < threshold) {
      await context.releaseOwnership(mem.id, CHAT_DOMAIN_ID)
    }
  }
}
```

- [ ] **Step 4: Run prune tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts`
Expected: Prune tests PASS

- [ ] **Step 5: Run full test suite, lint, and typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/domains/chat/schedules.ts tests/chat-domain.test.ts
git commit -m "feat(chat): implement decay-based pruning schedule"
```

---

### Task 11: Build Context Implementation

**Files:**
- Modify: `src/domains/chat/chat-domain.ts`
- Modify: `tests/chat-domain.test.ts`

- [ ] **Step 1: Write buildContext tests**

Add to `tests/chat-domain.test.ts`:

```typescript
describe('Chat domain - buildContext', () => {
  let engine: MemoryEngine
  let llm: MockLLMAdapter

  beforeEach(async () => {
    llm = new MockLLMAdapter()
    llm.extractResult = []
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      context: { userId: 'test-user', chatSessionId: 'session-1' },
      llm,
      embedding: new MockEmbeddingAdapter(),
    })
    await engine.registerDomain(createTopicDomain({ mergeSchedule: { enabled: false } }))
    await engine.registerDomain(createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
      pruneSchedule: { enabled: false },
    }))
  })

  afterEach(async () => {
    await engine.close()
  })

  test('buildContext includes working memory from current session', async () => {
    await engine.ingest('Hello, I need help with TypeScript', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const result = await engine.buildContext('TypeScript help', {
      domains: [CHAT_DOMAIN_ID],
      context: { userId: 'test-user', chatSessionId: 'session-1' },
    })

    expect(result.context).toContain('Hello, I need help with TypeScript')
    expect(result.totalTokens).toBeGreaterThan(0)
  })

  test('buildContext returns empty context when userId is missing', async () => {
    await engine.ingest('Hello', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
    })
    await engine.processInbox()

    const result = await engine.buildContext('test', {
      domains: [CHAT_DOMAIN_ID],
      context: { chatSessionId: 'session-1' },
    })

    expect(result.context).toBe('')
    expect(result.memories).toHaveLength(0)
  })

  test('buildContext includes episodic and semantic memories', async () => {
    const ctx = engine.createDomainContext(CHAT_DOMAIN_ID)

    // Create episodic memory directly
    await ctx.writeMemory({
      content: 'User prefers functional programming style',
      tags: [CHAT_TAG, CHAT_EPISODIC_TAG],
      ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: { layer: 'episodic', userId: 'test-user', weight: 0.7 },
      },
    })

    // Create semantic memory directly
    await ctx.writeMemory({
      content: 'User is a senior TypeScript developer',
      tags: [CHAT_TAG, CHAT_SEMANTIC_TAG],
      ownership: {
        domain: CHAT_DOMAIN_ID,
        attributes: { layer: 'semantic', userId: 'test-user', weight: 0.9 },
      },
    })

    const result = await engine.buildContext('TypeScript', {
      domains: [CHAT_DOMAIN_ID],
      context: { userId: 'test-user', chatSessionId: 'session-1' },
    })

    expect(result.context).toContain('functional programming')
    expect(result.context).toContain('senior TypeScript developer')
  })

  test('buildContext does not include other sessions working memory', async () => {
    await engine.ingest('Session 1 message', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
      context: { userId: 'test-user', chatSessionId: 'session-1' },
    })
    await engine.processInbox()

    await engine.ingest('Session 2 message', {
      domains: [CHAT_DOMAIN_ID],
      metadata: { role: 'user' },
      context: { userId: 'test-user', chatSessionId: 'session-2' },
    })
    await engine.processInbox()

    const result = await engine.buildContext('message', {
      domains: [CHAT_DOMAIN_ID],
      context: { userId: 'test-user', chatSessionId: 'session-1' },
    })

    expect(result.context).toContain('Session 1 message')
    expect(result.context).not.toContain('Session 2 message')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chat-domain.test.ts`
Expected: FAIL — buildContext not implemented on chat domain

- [ ] **Step 3: Implement buildContext**

Add `buildContext` to the domain config in `src/domains/chat/chat-domain.ts`:

```typescript
import type { ContextResult } from '../../core/types.ts'
import {
  CHAT_TAG,
  CHAT_MESSAGE_TAG,
  CHAT_EPISODIC_TAG,
  CHAT_SEMANTIC_TAG,
} from './types.ts'

// Inside createChatDomain, add to the returned DomainConfig:
async buildContext(text: string, budgetTokens: number, context: DomainContext): Promise<ContextResult> {
  const userId = context.requestContext.userId as string | undefined
  if (!userId) {
    return { context: '', memories: [], totalTokens: 0 }
  }

  const chatSessionId = context.requestContext.chatSessionId as string | undefined
  const memories: ScoredMemory[] = []
  let totalTokens = 0

  // Budget allocation: 50% working, 30% episodic, 20% semantic
  const workingBudget = Math.floor(budgetTokens * 0.5)
  const episodicBudget = Math.floor(budgetTokens * 0.3)
  const semanticBudget = budgetTokens - workingBudget - episodicBudget

  // Section 1: Recent — working memory for current session
  const sections: string[] = []

  if (chatSessionId) {
    const workingMemories = await context.getMemories({
      tags: [CHAT_MESSAGE_TAG],
      attributes: { chatSessionId, userId, layer: 'working' },
    })

    // Sort by createdAt (proxy for messageIndex)
    const sorted = workingMemories.sort((a, b) => a.createdAt - b.createdAt)

    let workingTokens = 0
    const recentLines: string[] = []
    for (const mem of sorted) {
      if (workingTokens + mem.tokenCount > workingBudget) break
      recentLines.push(mem.content)
      workingTokens += mem.tokenCount
      totalTokens += mem.tokenCount
    }

    if (recentLines.length > 0) {
      sections.push('[Recent]\n' + recentLines.join('\n'))
    }
  }

  // Section 2: Context — episodic memories (cross-session, user-scoped)
  if (text) {
    const episodicResult = await context.search({
      text,
      tags: [CHAT_EPISODIC_TAG],
      tokenBudget: episodicBudget,
    })
    const episodicFiltered = episodicResult.entries.filter(
      e => e.domainAttributes[CHAT_DOMAIN_ID]?.userId === userId
    )
    if (episodicFiltered.length > 0) {
      const contextLines = episodicFiltered.map(e => e.content)
      sections.push('[Context]\n' + contextLines.join('\n'))
      memories.push(...episodicFiltered)
      totalTokens += episodicFiltered.reduce((sum, e) => sum + e.tokenCount, 0)
    }

    // Section 3: Background — semantic memories (user-scoped)
    const semanticResult = await context.search({
      text,
      tags: [CHAT_SEMANTIC_TAG],
      tokenBudget: semanticBudget,
    })
    const semanticFiltered = semanticResult.entries.filter(
      e => e.domainAttributes[CHAT_DOMAIN_ID]?.userId === userId
    )
    if (semanticFiltered.length > 0) {
      const bgLines = semanticFiltered.map(e => e.content)
      sections.push('[Background]\n' + bgLines.join('\n'))
      memories.push(...semanticFiltered)
      totalTokens += semanticFiltered.reduce((sum, e) => sum + e.tokenCount, 0)
    }
  }

  return {
    context: sections.join('\n\n'),
    memories,
    totalTokens,
  }
},
```

- [ ] **Step 4: Run buildContext tests to verify they pass**

Run: `bun test tests/chat-domain.test.ts`
Expected: buildContext tests PASS

- [ ] **Step 5: Run lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/domains/chat/chat-domain.ts tests/chat-domain.test.ts
git commit -m "feat(chat): implement buildContext with tiered budget allocation"
```

---

### Task 12: Final Validation and Cleanup

**Files:**
- Review all files in `src/domains/chat/`
- Review `tests/chat-domain.test.ts`

- [ ] **Step 1: Verify no stub code remains**

Check that all functions in `src/domains/chat/schedules.ts` and `src/domains/chat/inbox.ts` have real implementations (no stub comments).

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass (including existing topic, user, domain-visibility tests)

- [ ] **Step 3: Run lint and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: No errors

- [ ] **Step 4: Verify file structure matches plan**

Run: `ls -R src/domains/chat/`
Expected:
```
chat-domain.ts
inbox.ts
index.ts
schedules.ts
skills.ts
structure.md
types.ts
skills/
  chat-ingest.md
  chat-query.md
  chat-processing.md
```

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -A src/domains/chat/ tests/chat-domain.test.ts
git commit -m "feat(chat): complete chat domain implementation"
```
