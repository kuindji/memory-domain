# Domain .md Files & Cross-Domain Access Control

Two related improvements to the domain system:
1. Move domain structure and skill content from inline TypeScript strings to standalone `.md` files, loaded lazily on demand.
2. Enforce cross-domain visibility rules consistently across all DomainContext read operations.

## 1. Domain `.md` Files

### Problem

Domain structure descriptions and skill content are currently embedded as markdown strings in TypeScript files (`structure` on DomainConfig, `content` on DomainSkill). This makes them hard to find, edit, and review. The pattern should be consistent across all domains — built-in, third-party npm packages, and local project domains.

### Convention

Each domain directory follows this layout:

```
<domain-dir>/
  structure.md            # optional — documents the domain's data structure
  skills/                 # optional directory — one .md per skill
    <skill-id>.md
  <domain>.ts             # domain config factory
  types.ts
  ...
```

- `structure.md` describes the domain's tags, ownership attributes, nodes, edges, and how they relate. This is consumed by agents to understand the domain's data model.
- `skills/<skill-id>.md` contains the full skill documentation. The skill id in the DomainSkill metadata must match the filename (without extension).
- Both are optional. A domain may have no structure doc and no skills, or any combination.

### DomainConfig Changes

Add `baseDir` field. Remove `structure` string field. Remove `content` from `DomainSkill`.

```typescript
interface DomainConfig {
  id: string
  name: string
  baseDir: string              // absolute path to the domain's source directory
  schema?: DomainSchema
  skills?: DomainSkill[]
  settings?: DomainSettings
  processInboxItem(entry: OwnedMemory, context: DomainContext): Promise<void>
  search?: {
    rank?(query: SearchQuery, candidates: ScoredMemory[]): Promise<ScoredMemory[]>
    expand?(query: SearchQuery, context: DomainContext): Promise<SearchQuery>
  }
  buildContext?(text: string, budget: number, context: DomainContext): Promise<ContextResult>
  describe?(): string
  schedules?: DomainSchedule[]
}

interface DomainSkill {
  id: string
  name: string
  description: string
  scope: 'internal' | 'external' | 'both'
  // content removed — loaded from baseDir/skills/{id}.md
}
```

The `structure` field is removed from DomainConfig entirely. Its presence is inferred from the existence of `structure.md` in `baseDir`.

### baseDir Resolution

Domain authors set `baseDir` using `import.meta.url`:

```typescript
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

export function createTopicDomain(options?): DomainConfig {
  return {
    id: 'topic',
    name: 'Topic',
    baseDir: dirname(fileURLToPath(import.meta.url)),
    skills: [
      { id: 'topic-management', name: 'Topic Management', description: '...', scope: 'external' },
      { id: 'topic-query', name: 'Topic Query', description: '...', scope: 'external' },
      { id: 'topic-processing', name: 'Topic Processing', description: '...', scope: 'internal' },
    ],
    // ...
  }
}
```

This works identically whether the domain runs from TypeScript source (bun) or compiled JavaScript (node via npm).

### Lazy Loading

Files are read from disk only when requested, not at domain registration time. The DomainRegistry gains two async methods:

- `getStructure(domainId): Promise<string | null>` — reads `{baseDir}/structure.md`. Returns null if the file does not exist.
- `getSkillContent(domainId, skillId): Promise<string | null>` — reads `{baseDir}/skills/{skillId}.md`. Returns null if the file does not exist.

File reads use `node:fs/promises` `readFile`, which works in both bun and node.

### CLI Impact

The `domain <id> structure` and `domain <id> skill <skillId>` commands call the new async registry methods instead of reading from the config object. No change to the command interface — only the internal data source changes.

### Migration

- Move existing inline markdown from `skills.ts` files into `skills/<skill-id>.md` files for topic and user domains.
- Move existing `STRUCTURE` constants from domain files into `structure.md` files.
- Remove the now-unused TypeScript constants and `content` fields.
- The log domain has no structure or skills; it only needs `baseDir` added.

---

## 2. Cross-Domain Access Control

### Problem

Domain visibility settings (`includeDomains` / `excludeDomains` in DomainSettings) are only enforced during `search()`. Other read operations on DomainContext (`getMemory`, `getMemories`, `getNodeEdges`, `getMemoryTags`) bypass visibility checks, allowing a domain to read data it shouldn't see.

### Enforcement Surface

All DomainContext read operations that return memory data enforce visibility:

| Method | Enforcement |
|--------|-------------|
| `search()` | Already enforced — no change needed |
| `getMemory(id)` | Check if the memory is owned by at least one domain in the caller's visible set. Return null if not visible. |
| `getMemories(filter?)` | Filter results to only memories owned by at least one visible domain. Batch ownership lookup for efficiency. |
| `getNodeEdges(nodeId, direction?)` | Filter returned edges to exclude those connecting to memories owned exclusively by non-visible domains. |
| `getMemoryTags(memoryId)` | If the memory itself is not visible (same check as getMemory), return empty array. |

### Write Operations Are Unrestricted

Write operations (`writeMemory`, `addTag`, `tagMemory`, `addOwnership`, `updateAttributes`, etc.) are not subject to visibility filtering. A domain can freely create and own data. The control governs what a domain can *read* from other domains, not what it can produce.

### Visibility Check Implementation

The check for a single memory: "does this memory have at least one `owned_by` edge pointing to a domain in the caller's visible set?"

For `getMemory()` and `getMemoryTags()`: fetch the memory's ownership edges, check against `getVisibleDomains()`.

For `getMemories()`: batch ownership lookup — query all `owned_by` edges for the candidate memories in one operation, then filter.

For `getNodeEdges()`: for each returned edge, if the connected node is a memory, verify its ownership. Non-memory nodes (tags, user nodes, etc.) pass through without ownership checks.

### Edge Cases

- **Unowned memories** (no `owned_by` edges): invisible to all domains. This shouldn't happen in normal operation but provides a safe default.
- **Log domain**: already excluded from `resolveVisibleDomains()` by default. No domain sees log-owned memories unless it explicitly includes `log` in `includeDomains`.
- **Domain's own data**: a domain always sees its own data — `resolveVisibleDomains()` always includes self.
