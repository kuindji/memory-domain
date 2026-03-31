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
