# Chat Querying

Retrieve conversational memory using search and context building.

## Building Context

Use `build-context` to assemble a token-budgeted context string from all three memory tiers:

```sh
node memory-domain build-context "<content-to-build-context-for>" \
  --domains chat \
  --budget 4000 \
  --meta userId=user-123 \
  --meta chatSessionId=session-456
```

The assembled context contains three sections:

1. **Recent** — Working memory filtered by `chatSessionId`, ordered by `messageIndex`
2. **Context** — Episodic memory filtered by `userId`, ranked by relevance and recency
3. **Background** — Semantic memory filtered by `userId`, ranked by relevance

## Searching Chat Memories

```sh
# Find episodic memories for a user
memory-domain search "<query>" \
  --domains chat \
  --tags chat/episodic \
  --meta userId=user-123

# Find working memories for a session
memory-domain search "" \
  --domains chat \
  --tags chat/message \
  --meta userId=user-123 \
  --meta chatSessionId=session-456
```

## Available Tags

| Tag | Tier |
|-----|------|
| `chat/message` | Working memory (raw messages) |
| `chat/episodic` | Episodic memory (session summaries) |
| `chat/semantic` | Semantic memory (cross-session knowledge) |
