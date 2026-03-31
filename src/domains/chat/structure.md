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
