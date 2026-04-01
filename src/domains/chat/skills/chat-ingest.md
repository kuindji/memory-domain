# Chat Ingestion

Feed messages into the chat domain. Both user and assistant messages are supported.

## Required Metadata

Every ingestion call must include `userId` and `chatSessionId` via `--meta`.
Use the `role` metadata field to distinguish user input from agent output.

```sh
node memory-domain ingest --domains chat \
  --meta userId=user-123 \
  --meta chatSessionId=session-456 \
  --meta role=user|assistant \
  --text "<user-or-agent-message>"
```
