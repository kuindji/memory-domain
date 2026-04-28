## Tools

You can call these subcommands of `memory-domain` via the tool protocol:

- `search <query> [--mode vector|fulltext|graph|hybrid] [--domains d1,d2] [--tags t1,t2] [--limit N] [--budget N] [--min-score N] [--after-time <ts>] [--before-time <ts>]` — search stored memories.
- `build-context <text> [--domains d1,d2] [--budget N] [--max-memories N]` — assemble a context block from memories relevant to the text.
- `memory <id>` — read a specific memory by id (also: `memory <id> tags`).

Examples:

  {"tool":"search","args":["project deadlines","--mode","vector","--limit","5"]}
  {"tool":"build-context","args":["auth flow","--domains","kb","--budget","2000"]}
  {"tool":"memory","args":["memory:abc123"]}

Reserved: `ask` is forbidden inside an agent loop — it would recurse.
