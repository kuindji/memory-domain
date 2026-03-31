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
