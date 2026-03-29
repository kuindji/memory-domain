# Project Knowledge Domain Design

## Overview

A single domain (`project-knowledge`) that captures the invisible knowledge layer around a codebase: architectural decisions and their rationale, business logic semantics, design direction, and the relationships between system components. This knowledge cannot be derived from code or git history alone — it lives in conversations, developers' heads, and ephemeral agent sessions.

## Goals

Given sufficient history (either accumulated through continuous use or thoroughly backfilled), the project-knowledge domain should contain enough structured knowledge to generate:

- **Technical architecture overviews** — system component maps, data flows, service interactions, technology choices and their rationale
- **Business architecture overviews** — domain model explanations, data semantics, business rule documentation, entity relationships and their real-world meaning
- **Project documentation** — to the extent that decisions, rationale, and direction are captured, the domain becomes a source for generating and maintaining architectural docs, onboarding guides, and decision logs

This is a long-term goal that validates the domain's value: if the knowledge graph is rich enough to produce these artifacts, it means the domain is capturing what matters.

## Key Design Decisions

- **Single domain, not two.** Initially considered separate Codebase and BusinessLogic domains, but the processing logic is identical — only the audience differs. Consumer asymmetry (non-technical users shouldn't see implementation details) is handled via audience tags and `buildContext` filtering, not domain separation.
- **Agent as primary scribe.** The agent writes curated memories continuously during sessions. No raw conversation ingestion — the agent is the intelligent filter that determines significance.
- **Scoping via graph, not domain instances.** A monorepo with many subsystems gets one domain instance. Module boundaries, packages, and subsystem relationships are entity nodes and edges within the domain.
- **Content is the invisible layer.** Memories capture what can't be discovered from code: decisions and rationale, intent that hasn't materialized yet, and the real-world meaning of data that code names don't convey.

## Schema

### Audience Tags

Every memory is tagged with one or both of:
- `technical` — implementation architecture, decisions, direction
- `business` — data semantics, business rules, real-world meaning

### Memory Classification (stored as metadata)

- `decision` — "we chose X because Y"
- `rationale` — "the reason this works this way is..."
- `clarification` — "despite the name, this actually means..."
- `direction` — "we're moving toward X"
- `observation` — system-detected change from scheduled scan
- `question` — flagged gap needing human input ("new status added — what does it mean?")

### Entity Node Types

| Node | Fields | Purpose |
|------|--------|---------|
| `module` | `name`, `path`, `kind` | Package, lambda, service, subsystem |
| `data_entity` | `name`, `source` | Domain object (Order, Payment, Return) |
| `concept` | `name`, `description` | Business concept (reconciliation, return flow) |
| `pattern` | `name`, `scope` | Architectural/design pattern in use |

### Edge Types

**Memory-to-entity:**
- `about(memory -> module|data_entity|concept|pattern)` — what this memory is about. Fields: `relevance`

**Memory-to-memory:**
- `supersedes(memory -> memory)` — newer decision replaces older one (preserves history)
- `raises(memory -> memory)` — an observation raises a question

**Entity-to-entity (architecture graph):**
- `connects_to(module -> module)` — runtime communication. Fields: `protocol` (http, sqs, sns, direct), `direction` (sync, async), `description`
- `manages(module -> data_entity)` — service owns/handles this entity. Fields: `role` (owner, reader, transformer)
- `contains(module -> module)` — structural nesting (package contains lambdas)
- `implements(module -> concept)` — module implements this business concept
- `has_field(data_entity -> data_entity)` — entity composition/relationships. Fields: `cardinality` (one, many)

## Processing

### processInboxItem

Receives agent-curated memories (already determined to be significant). Processing steps:

1. Use LLM to extract entity references the agent may have missed
2. Create or link entity nodes (`module`, `data_entity`, `concept`, `pattern`)
3. Check for contradictions with existing memories
4. If a new decision contradicts an older one, create `supersedes` edge (keeps both, marks staleness)
5. If classification is `question`, ensure it's tagged for surfacing in future sessions

Does NOT:
- Re-analyze content significance (agent already did that)
- Process raw conversation (agent is the filter)

### Entity Graph Population

Two sources:

1. **Agent during sessions** — writes a memory, `processInboxItem` extracts entities and relationships (e.g., "order-processor sends to payment-processor via SQS" creates modules, `connects_to` edge, and `about` edges)
2. **Commit scanner** — detects structural changes and updates entities (new directories become module nodes, new imports become `connects_to` edges, deleted modules get marked but not removed since memories still reference them)

Agent-provided knowledge takes precedence over scanner-inferred knowledge. The scanner sees static structure; the agent captures intent.

## Context Building & Search

### buildContext (audience-aware)

Filters memories by audience tag:
- Query with `tags: ['technical']` — returns all technical memories (developer asking)
- Query with `tags: ['business']` — returns only business memories (non-technical asking)
- No audience tag — returns everything (default for developers)

### search.expand (query enrichment)

1. Look up entity nodes matching query terms
2. Add graph traversal hints — follow `about` edges from matched entities
3. Add related entities via `implements`, `manages`, `connects_to`

### search.rank (domain-specific ranking)

1. `decision` and `rationale` ranked above `observation`
2. Non-superseded memories ranked above superseded ones
3. `question` memories ranked lower unless query is specifically about gaps

### Architecture graph queries

Use standard `search` API with `traversal`:
- "What talks to order-processor?" — traverse `connects_to` from that module
- "What modules handle orders?" — traverse `manages` to `data_entity:order`
- "Show me the payment flow" — start from `concept:payment-flow`, traverse `implements` back to modules, then `connects_to` between them

## Schedules

Both optional, enabled via domain options:

### Commit Scanner

- Configurable interval
- Reads git log since last run (tracked via `ctx.setMeta`)
- Detects: new/deleted/moved files, new dependencies, structural changes, new enum values or status fields
- Creates `observation` memories tagged `technical`
- Creates `question` memories when changes suggest business logic shifts needing human explanation
- Updates entity nodes and entity-to-entity edges

### Drift Detector

- Configurable interval
- Queries existing `decision` and `direction` memories
- Cross-references with current codebase state
- Creates `observation` memories for detected drift
- Creates `supersedes` edges when decisions are clearly no longer reflected in code

## Agent Integration

### How agents use the domain

1. `active-memory` installed as npm package
2. Domain registered via `active-memory.config.js` in project root
3. Agents interact via CLI: `active-memory remember`, `search`, `ask`, `context`
4. CLI reflects the base MemoryEngine API — domain-agnostic commands with tags and metadata
5. `active-memory skill` command generates composed instruction text from:
   - General CLI usage (applies to all domains)
   - Domain-specific SKILL.md from each registered domain

### SKILL.md (domain-specific agent instructions)

The project-knowledge domain provides a SKILL.md that tells agents:
- What kind of knowledge to capture (decisions, rationale, clarifications, direction)
- How to tag it (audience: `technical`/`business`, type via metadata)
- When to capture (continuously, as side effect of normal work)
- Examples of good memories

### Platform hooks

- Claude Code: instructions injected into `CLAUDE.md`
- Codex: instructions injected into `AGENTS.md`
- Gemini CLI: instructions injected into `GEMINI.md`
- Taskflow: instructions in system prompt

## Scope Boundaries

### In scope
- `project-knowledge` domain implementation (schema, processInboxItem, buildContext, search hooks, schedules, SKILL.md)

### Out of scope (deferred)
- CLI implementation (general active-memory infrastructure)
- `active-memory.config.js` format and loader (general infrastructure)
- `active-memory skill` command (general infrastructure)
- Deployment of scheduled processing (operational concern)
- MCP server (potential future alternative to CLI)

### Open questions for implementation
1. How does `processInboxItem` invoke LLM for entity extraction? Structured prompt vs tool use.
2. What does the commit scanner actually parse? File structure only, or code semantics via LLM?
3. How granular should entity nodes be? One node per package, or individual lambdas get their own?
