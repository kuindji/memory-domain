# Capturing Project Knowledge

Record curated project knowledge — decisions, rationale, clarifications, and direction. Focus on knowledge that cannot be derived from code or git history.

## What to Capture

- **Decisions** — "We chose SQS over direct HTTP for order processing because of retry guarantees"
- **Rationale** — "The reason payments use a separate database is regulatory isolation"
- **Clarifications** — "Despite the name, UserProfile is actually the billing entity, not the identity record"
- **Direction** — "We're migrating from REST to gRPC for all inter-service communication"

Do NOT capture: implementation details visible in code, commit messages, or existing documentation.

## Ingesting Project Knowledge

```sh
node memory-domain ingest --domains project \
  --meta classification=decision \
  --meta audience=technical,business \
  --text "We chose event sourcing for the order pipeline because we need full audit trail for compliance"
```

### Required Metadata

| Key | Values |
|-----|--------|
| `classification` | `decision`, `rationale`, `clarification`, `direction` |
| `audience` | `technical`, `business` (one or both, comma-separated) |

## Entity Graph

When writing about specific architectural components, create entity nodes and link memories to them using graph commands.

### Entity Types

| Type | Example |
|------|---------|
| `module` | Services, packages, subsystems |
| `data_entity` | Database tables, message schemas |
| `concept` | Business concepts, domain terms |
| `pattern` | Design patterns, conventions |

### Entity Relationships

| Edge Type | Meaning |
|-----------|---------|
| `connects_to` | Service-to-service communication |
| `manages` | Service owns a data entity |
| `implements` | Module implements a concept |
| `contains` | Structural nesting |
| `about_entity` | Memory is about an entity |

```sh
# Link a memory to an entity
node memory-domain graph relate <memory-id> <entity-id> about_entity --domain project

# Relate two entities
node memory-domain graph relate <module-id> <data-entity-id> manages --domain project
```

## When to Capture

Capture continuously as a side effect of normal work:

- During code review, when you notice a design choice worth explaining
- After a discussion that clarifies why something works a certain way
- When making a decision that affects architecture or data flow
- When business meaning of a field or entity isn't obvious from the code
