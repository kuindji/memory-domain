# User Domain Design

## Overview

The User domain is a built-in primitive that serves as a cross-domain aggregator around user identity. It owns general user facts (identity, preferences, expertise, goals) and provides an anchor node that other domains link their user-relevant data to.

The User domain does not process inbox items. Data enters through its external skill, written by other domains or external agents.

## Framework Changes: Request Context

### Type

`RequestContext` is `Record<string, unknown>` — an opaque bag the framework carries without interpreting. Specific fields (like `userId`) are domain concerns, not framework concerns.

### Instance-level default

`EngineConfig` gains an optional `context?: RequestContext` field. This sets the default request context for all API calls on this engine instance.

### Per-request override

Each API method's options type gains `context?: RequestContext`:
- `IngestOptions`
- `SearchQuery`
- `AskOptions`
- `ContextOptions`

### Merge behavior

On every API call, the engine shallow-merges instance context with per-request context. Per-request values take precedence.

```
merged = { ...engineConfig.context, ...options.context }
```

### Propagation

The merged context is exposed on `DomainContext` as `requestContext: RequestContext`. All domains can read it.

For inbox processing and scheduled tasks (no caller request), `requestContext` falls back to the engine default or empty object.

## Framework Changes: Tag & Edge Querying

Two methods added to `DomainContext`:

- `getMemoryTags(memoryId: string): Promise<string[]>` — returns tag labels for a memory.
- `getNodeEdges(nodeId: string, direction?: 'in' | 'out' | 'both'): Promise<Edge[]>` — returns edges connected to any graph node.

CLI surfaces tags and edges in relevant output where applicable.

## User Domain

### Identity

- `id: 'user'`
- Built-in but explicitly registered by the consumer (not auto-registered like Log domain).

### Graph Schema

**Node: `user`**
- Fields: `userId` (string)
- One node per unique userId
- Created lazily by the User domain on first encounter of a userId in the request context

**Edge: `about_user`**
- From any memory to a user node
- Available to any domain when the relationship is "about" the user
- Optional `domain` field to track which domain created the link
- Other domains may define and use their own edges to the user node when the relationship is something other than "about" (e.g., `chat_participant`, `topic_owner`)

### Tag Hierarchy

```
user/
  identity/       -- name, location, profession, affiliations
  preference/     -- communication style, tool choices, likes/dislikes
  expertise/      -- skills, knowledge areas, experience level
  goal/           -- intentions, aspirations, longer-term objectives
```

Other domains may extend this hierarchy with their own tags as needed.

### Inbox Processing

None. Data enters only through the external skill.

### Skills

1. **user-data** (external) — How to store user facts: write a memory, tag it under the `user/` hierarchy, link it to the user node via `about_user` edge.
2. **user-query** (external) — How to retrieve user data: traverse edges from the user node, filter by tags, search within user-owned memories.
3. **user-profile** (internal) — Used by the consolidation schedule to synthesize a cross-domain user view.

### Schedules

1. **consolidate-user-profile** — Periodically traverses all edges pointing to/from the user node across domains, synthesizes a summary memory (tagged `user/profile-summary` or similar), updates/replaces the previous summary. Uses `getNodeEdges` for cross-domain discovery.

Staleness detection and cleanup are consumer-domain concerns, not the User domain's responsibility.

### Search

The User domain provides a `search.expand` hook. When `userId` is present in the request context and a user node exists, the hook augments queries with user context (preferences, expertise) to improve relevance. Only activates if the User domain is registered and userId is present.

### Domain Settings

`includeDomains` left unset — the User domain needs cross-domain visibility for its consolidation schedule.

## Design Decisions

- **userId is per-request, not per-engine** — supports both single-tenant (set on engine config) and multi-tenant (set per API call) usage. The two merge, with per-request taking precedence.
- **RequestContext is opaque** — the framework does not define specific fields. Domains read what they need and do their own type narrowing. This avoids leaking domain-specific concerns into the framework.
- **User domain is a primitive** — like Topic domain, it provides shared infrastructure for other domains. It does not own staleness detection or cleanup.
- **User node is a graph entity, not a memory** — the node is a minimal anchor (userId only). All actual knowledge lives in memories linked to the node.
- **Lazy node creation** — the User domain creates the user node, not the framework. The framework provides helpers and lifecycle events.
- **Other domains use their own edges** — `about_user` is available when the relationship is genuinely "about" the user, but domains are free to define edges that better fit their data model.
