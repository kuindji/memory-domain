# Bootstrap Refinement Plan

## Context

The project domain bootstrap now works (two-phase: triage → analysis with code reading), but the output has quality issues:
- Self-referencing relationships (core→core)
- Missing cross-module relationships
- Overly granular data entities (every TypeScript type extracted)
- No patterns detected on first run (now fixed with code reading)

The goal is to refine prompts and validation until bootstrap produces accurate, useful entity graphs across 4 test projects of increasing size:
1. **active-memory** itself (~40 dirs, small)
2. **Taskflow** (~253 dirs, medium)  — `/Users/kuindji/Projects/taskflow`
3. **TheFloorr** (~13k dirs, large monorepo) — `/Users/kuindji/Projects/TheFloorr/monorepo`
4. **Vigilocity** (~24k dirs, large monorepo) — `/Users/kuindji/Projects/Vigilocity/monorepo`

Projects 2-4 need `file:` dependency on active-memory in their `package.json` and an `active-memory.config.ts`.

---

## Phase 1: Fix Known Bugs in Bootstrap Code

**File: `src/domains/project/bootstrap.ts`**

### 1.1 Filter self-relationships
In the relationship creation loop, add: `if (fromId === toId) continue`

### 1.2 Improve formatTree to include files (not just dirs)
Currently `formatTree` only shows directories. The triage LLM needs to see filenames to pick which ones to read. Show files at each level (just names, not content). Cap at reasonable count per directory (e.g., first 30 files).

### 1.3 Scan depth for large repos
Currently fixed at 4 levels. For repos with >100 directories, 3 levels may be more appropriate to keep the tree prompt manageable. Make `maxDepth` dynamic based on dir count estimate, or let triage assess.

---

## Phase 2: Refine LLM Prompts

### 2.1 TRIAGE_PROMPT improvements

Current issues:
- Doesn't see filenames, only directory names with `[key files]` annotations
- Can't make informed decisions about which source files to read

Refinements:
- Show all filenames in tree (not just key files), capped per dir
- Add guidance: "Prefer type definition files, entry points (index.ts, main.ts, mod.rs), and config files. Avoid test files, fixtures, generated code, lock files."
- Add: "For monorepos, prioritize shared packages and core services over apps/frontends"
- Add: "Return paths relative to project root"

### 2.2 ANALYSIS_PROMPT improvements

Current issues:
- `data_entity` extraction too granular — gets every interface/type
- `relationships` section too vague — LLM doesn't know what connects_to means
- No guidance on entity naming consistency
- No constraint on what constitutes a "module" vs just a directory

Refinements:
- **Modules**: "Identify architectural boundaries — packages, services, significant sub-systems. NOT every directory. A module should represent something a team or person would own or describe as a unit."
- **Data entities**: "Only include domain/business objects that cross module boundaries or represent core data models (e.g., User, Order, Payment). Exclude internal utility types, config shapes, helper interfaces, and framework-specific types."
- **Relationships**: Explicitly describe each type with examples:
  - `contains`: "Parent module structurally nests child module (e.g., monorepo root contains packages)"
  - `connects_to`: "Runtime communication — HTTP calls, message queues, shared database, event bus. Must be between two different modules."
  - `implements`: "Module realizes a business concept (e.g., billing-service implements Subscription Management)"
- **Patterns**: "Architectural patterns you observe in the code structure and implementations — e.g., Event Sourcing, CQRS, Repository Pattern, Factory, Strategy. Include where each pattern is applied."
- Add constraint: "Every relationship must be between two DIFFERENT entities. No self-references."
- Add constraint: "Module names should be short, lowercase, hyphenated identifiers (e.g., order-processor, not OrderProcessor or src/services/order)"

### 2.3 Inbox ENTITY_EXTRACTION_PROMPT refinement

Less urgent but worth doing while we're at it:
- "Extract only entities that are proper nouns in the project context — specific module names, service names, data models. Do not extract generic terms like 'database', 'API', 'service' unless they refer to a named component."

---

## Phase 3: Add Validation Layer

**File: `src/domains/project/bootstrap.ts`**

After LLM returns analysis JSON, validate before writing to graph:

- Filter out self-relationships (`from === to`)
- Filter out duplicate entities (same name + type)
- Filter out modules with no path or nonsensical paths
- Filter out relationships referencing non-existent module names
- Warn (log) about entities with suspiciously generic names ("Service", "API", "Data")

This is a safety net — prompt refinement is the primary quality lever, validation catches residual issues.

---

## Phase 4: Test on active-memory

1. Clear DB: `rm -rf .active-memory/db`
2. Run: `bun src/cli/cli.ts init --yes`
3. Analyze output:
   - Are modules correct? (should be: core, cli, adapters, domains/topic, domains/user, domains/chat, domains/project)
   - Are data entities meaningful? (MemoryEntry, DomainConfig, Tag — not every interface)
   - Are relationships accurate? (no self-refs, cross-module connections exist)
   - Are patterns identified? (Factory, Event Emitter, Hybrid Search, etc.)
4. If issues found → refine prompts → repeat

---

## Phase 5: Set Up Target Projects

For each of Taskflow, TheFloorr, Vigilocity:

### 5.1 Add file: dependency
In each project's `package.json`:
```json
"active-memory": "file:../path/to/active-memory"
```
Then `bun install`.

### 5.2 Create active-memory.config.ts
Each project gets its own config with:
- `surrealkv://` connection pointing to `.active-memory/db` in the project
- ClaudeCliAdapter with modelLevels (haiku/sonnet/opus)
- Topic domain + Project domain with `projectRoot`
- Ensure `.active-memory/` is in their `.gitignore`

### 5.3 Run bootstrap and evaluate
```sh
bun src/cli/cli.ts init --yes --config /path/to/project/active-memory.config.ts
```
Or from within the project: `bun active-memory init --yes`

---

## Phase 6: Iterative Refinement on Each Project

Work through projects in order of increasing size:

### 6.1 Taskflow (medium, ~253 dirs)
- Run bootstrap, analyze output
- Check: Does triage pick sensible files? Are monorepo packages identified as modules?
- Refinement focus: Module boundaries in a single-package repo with electron/packages structure

### 6.2 TheFloorr (large monorepo, ~13k dirs)
- Run bootstrap, analyze output
- Check: Does triage stay within budget? Are shared packages vs apps distinguished?
- Refinement focus: Large monorepo handling — triage should prioritize `packages/` and `services/` over `apps/` frontends
- May need to test that MAX_FILE_CONTENT_CHARS (60k) is sufficient

### 6.3 Vigilocity (large monorepo, ~24k dirs)
- Run bootstrap, analyze output
- Check: Similar to TheFloorr but even larger — does the approach scale?
- Refinement focus: Very deep directory trees, many services

### For each project, the refinement loop is:
1. Run bootstrap
2. Query DB for entities, relationships, concepts, patterns
3. Identify what's wrong or missing
4. Adjust prompts in `bootstrap.ts` (TRIAGE_PROMPT, ANALYSIS_PROMPT)
5. Clear DB, re-run
6. Repeat until output is accurate

---

## File Change Summary

| File | Changes |
|------|---------|
| `src/domains/project/bootstrap.ts` | Self-ref filter, formatTree with files, prompt refinements, validation layer, dynamic scan depth |
| `src/domains/project/inbox.ts` | ENTITY_EXTRACTION_PROMPT refinement (minor) |
| Target projects: `package.json` | Add `file:` dependency |
| Target projects: `active-memory.config.ts` | Create config files |
| Target projects: `.gitignore` | Add `.active-memory/` if not present |

## Verification

For each project, success means:
- Modules map to real architectural boundaries (not every directory)
- Data entities are business/domain objects (not utility types)
- Relationships are accurate (no self-refs, cross-module connections where they exist)
- Patterns reflect actual code patterns
- Concepts capture non-obvious domain knowledge
- No crashes or timeouts on large repos

## Notes for Next Session

- Start with Phase 1-3 (code fixes + prompt refinements) on active-memory
- Verify on active-memory (Phase 4) before moving to other projects
- Each project may reveal new prompt issues — expect 2-3 iterations per project
- Keep prompt changes minimal and targeted — don't rewrite everything at once
- The conversational deepening path (external skills) is separate future work — this plan focuses solely on automated bootstrap quality
