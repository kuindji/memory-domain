# CLI Data Manipulation & Internal API Design

## Overview

Add generic, domain-agnostic data manipulation commands to the CLI and corresponding
methods to the MemoryEngine internal API. Migrate all existing CLI commands to a
consistent output format.

## Principles

- **Domain-agnostic CLI** — the CLI knows nothing about specific domains. Domains
  describe operations in their skill files; consumer agents translate those into
  generic CLI primitives.
- **Explicit ownership** — `--domain` flag required on write/graph operations.
- **Extensible context** — `--meta key=value` (repeatable) replaces `--user-id` for
  request context metadata.
- **Agent-first output** — JSON by default. `--pretty` flag for human-readable tables.
- **Consistent envelope** — all commands return `{ ok, data }` or `{ ok, error }`.

## Output Format

### JSON envelope (default)

```json
{ "ok": true, "data": { ... } }
```

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "Memory abc not found" } }
```

### `--pretty` flag

Reuses existing table formatting from `src/cli/format.ts`. Available on all commands.

### `--meta` flag

Repeatable. Parsed into `RequestContext.metadata`:

```
--meta user-id=abc --meta session-id=xyz
```

Produces `{ metadata: { "user-id": "abc", "session-id": "xyz" } }`.

## New CLI Commands

### `write`

Direct memory creation with domain ownership. No dedup, no inbox processing.

```
active-memory write --domain <id> --text <text> [--tags t1,t2] [--attr key=value ...] [--meta key=value ...]
```

Returns: `{ id: string }`

### `memory`

Memory CRUD and tagging operations.

```
active-memory memory <id>                                          # read memory
active-memory memory <id> update [--attr key=value ...] [--text <text>]  # update
active-memory memory <id> tags                                     # list tags
active-memory memory <id> tag <tag>                                # add tag
active-memory memory <id> untag <tag>                              # remove tag
active-memory memory <id> release --domain <id>                    # release ownership
active-memory memory <id> delete                                   # delete memory
```

Returns:
- `memory <id>` — full memory object with tags, attributes, ownership, edges
- `memory <id> update` — `{ id: string }`
- `memory <id> tags` — `{ tags: string[] }`
- `memory <id> tag/untag` — `{ tags: string[] }` (updated list)
- `memory <id> release` — `{ id: string }`
- `memory <id> delete` — `{ id: string }`

### `graph`

Edge operations and traversal.

```
active-memory graph edges <node-id> [--direction in|out|both] [--domain <id>]
active-memory graph relate <from> <to> <edge-type> --domain <id> [--attr key=value ...]
active-memory graph unrelate <from> <to> <edge-type>
active-memory graph traverse <start-id> --edges <edge-types> [--depth N] [--domain <id>]
```

Returns:
- `graph edges` — `{ edges: Edge[] }`
- `graph relate` — `{ id: string }` (edge ID)
- `graph unrelate` — `{ removed: boolean }`
- `graph traverse` — `{ nodes: TraversalNode[] }` (nodes with depth info)

### `schedule`

Schedule introspection and manual triggering.

```
active-memory schedule list [--domain <id>]
active-memory schedule trigger <domain-id> <schedule-id>
```

Returns:
- `schedule list` — `{ schedules: ScheduleInfo[] }`
- `schedule trigger` — `{ triggered: true, domain: string, schedule: string }`

## Updated Existing Commands

All existing commands migrate to:
- `{ ok, data }` / `{ ok, error }` envelope
- JSON output by default
- `--pretty` flag for human-readable format
- `--user-id` removed, replaced by `--meta user-id=<value>`

Affected commands: `ingest`, `search`, `ask`, `build-context`, `domains`, `help`.

## Internal API: MemoryEngine Additions

### Memory CRUD

```typescript
writeMemory(text: string, options: WriteOptions): Promise<WriteResult>
getMemory(id: string): Promise<ScoredMemory | null>
updateMemory(id: string, options: UpdateOptions): Promise<void>
deleteMemory(id: string): Promise<void>
```

### Tagging

```typescript
tagMemory(id: string, tag: string): Promise<void>
untagMemory(id: string, tag: string): Promise<void>
getMemoryTags(id: string): Promise<string[]>
```

### Ownership

`releaseOwnership(id: string, domainId: string)` already exists.

### Graph

```typescript
getEdges(nodeId: string, direction?: 'in' | 'out' | 'both', domainId?: string): Promise<Edge[]>
relate(from: string, to: string, edgeType: string, domainId: string, attrs?: Record<string, unknown>): Promise<string>
unrelate(from: string, to: string, edgeType: string): Promise<void>
traverse(startId: string, edgeTypes: string[], depth?: number, domainId?: string): Promise<TraversalResult>
```

### Schedules

```typescript
listSchedules(domainId?: string): Promise<ScheduleInfo[]>
triggerSchedule(domainId: string, scheduleId: string): Promise<void>
```

## New Types

```typescript
interface WriteOptions {
  domain: string
  tags?: string[]
  attributes?: Record<string, unknown>
  context?: RequestContext
}

interface WriteResult {
  id: string
}

interface UpdateOptions {
  attributes?: Record<string, unknown>
  text?: string
}

interface ScheduleInfo {
  id: string
  domain: string
  name: string
  interval: number
  lastRun?: number
}

interface TraversalNode {
  id: string
  depth: number
  edge: string        // edge type that led here
  direction: 'in' | 'out'
  memory?: ScoredMemory  // populated if the node is a memory
}
```

## Flag Parsing

### `--attr` and `--meta`

Both use `key=value` syntax and are repeatable:

```
--attr status=active --attr count=3 --meta user-id=abc
```

Values are parsed as strings. Numeric coercion is not automatic — domains handle
type interpretation in their own logic.

### `--tags`

Comma-separated: `--tags topic,active,important`

### `--edges`

Comma-separated edge type list: `--edges subtopic_of,related_to`

### `--direction`

One of `in`, `out`, `both`. Defaults to `both`.

### `--depth`

Integer. Defaults to 1 for `graph traverse`.

## Not in Scope

- Domain-specific convenience commands
- New domain implementations
- Region primitive
