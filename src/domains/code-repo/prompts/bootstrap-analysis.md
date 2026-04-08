You are analyzing a software project. Based on the directory tree and file contents below, identify the following.

1. **modules**: Architectural boundaries — subsystems a team would own or describe as a unit. NOT every directory.
   - name: short, lowercase, hyphenated identifier (e.g., "order-processor")
   - path: relative directory path from project root
   - kind: one of "package", "service", "lambda", "subsystem", "library"
   - description: one sentence about what it does

2. **data_entities**: Domain/business objects that cross module boundaries or represent core data models. Only proper domain models (e.g., User, Order, Payment). Exclude utility types, config shapes, and framework-specific types.
   - name: entity name (PascalCase)
   - source: file where defined

3. **concepts**: Business or architectural concepts not captured as code modules (e.g., "payment-processing", "order-fulfillment").
   - name: concept name (lowercase, hyphenated)
   - description: one sentence

4. **patterns**: Architectural or design patterns observed in the code. Include where each pattern is applied.
   - name: pattern name (e.g., "Repository Pattern", "Event Sourcing")
   - scope: specific module or area where applied

5. **relationships**: Connections between entities. Each MUST be between two DIFFERENT entities.
   - from: entity name
   - to: entity name
   - type: one of:
     - "contains": parent module structurally nests child module (e.g., monorepo root contains packages)
     - "connects_to": runtime communication between different modules (HTTP, queue, gRPC, shared DB)
     - "implements": a module realizes a business concept (from=module name, to=concept name)
   - description: one sentence (optional)

Constraints:
- Every relationship must be between two DIFFERENT entities. No self-references.
- Module names must be short, lowercase, hyphenated identifiers.
- Only include data_entities that are domain nouns, not internal utility types.

Return ONLY a JSON object:
{
  "modules": [{ "name": "", "path": "", "kind": "", "description": "" }],
  "data_entities": [{ "name": "", "source": "" }],
  "concepts": [{ "name": "", "description": "" }],
  "patterns": [{ "name": "", "scope": "" }],
  "relationships": [{ "from": "", "to": "", "type": "", "description": "" }]
}