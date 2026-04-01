# Skill Rules

Rules for creating and managing domain skill files (`src/domains/<domain>/skills/*.md`).

## What Skills Are

Skill files are **system prompts** passed to LLM calls. They are not documentation. Every skill file should be written as directives that tell the model what to do, what rules to follow, and what context it needs.

## One Skill Per LLM Job

Each LLM-based operation gets its own skill file. Never combine multiple jobs into a single skill. When a schedule, inbox processor, context builder, or `ask()` function makes an LLM call, it should have a dedicated skill file containing only the context that specific call needs.

**Why:** Skills are loaded into model context. Combined files waste tokens on irrelevant instructions and risk confusing the model with unrelated directives.

## No Skill for Non-LLM Jobs

If a scheduled job or processing step does not call the LLM (pure math, git operations, filesystem checks, vector-only search), it does not need a skill file.

## Skill File Naming

Name the file after the operation it supports:
- Schedule skill: `<domain>-<schedule-id>.md` (e.g., `chat-promote-working-memory.md`)
- Inbox skill: `<domain>-inbox.md`
- Context builder skill: `<domain>-build-context.md`

The filename must match the `id` field in the `DomainSkill` registration in `skills.ts`.

## Skill Registration

Every skill file must have a corresponding `DomainSkill` entry in the domain's `skills.ts`:

```ts
const mySkill: DomainSkill = {
  id: 'domain-operation-name',    // matches filename without .md
  name: 'Short human-readable name',
  description: 'What LLM call this skill supports and what it instructs the model to do',
  scope: 'internal',              // or 'external' or 'both'
}
```

## Scope

- **internal**: Skills consumed by LLM calls inside memory-domain (schedules, inbox processing, context building). Not exposed to outer agents.
- **external**: Skills that tell outer agents how to interact with a domain via CLI. Loaded by the `skill` command.
- **both**: Skills relevant to both internal processing and outer agent usage.

## Skill Composition

Skills are designed to be combined. The main CLI guide (`cli-guide.md`) is included in every external skill load. Internal skills for a domain can similarly be layered:

- Keep shared knowledge (tag names, edge types, attribute schemas) in the domain's external skills or structure file
- Each internal skill should only contain what is unique to its specific LLM call
- Do not repeat CLI usage instructions in internal skills — the CLI guide handles that

## Writing Style

- Lead with the model's role: what it receives and what it should produce
- Use imperative rules: "Extract...", "Preserve...", "Do not..."
- Include just enough context about the surrounding system for the model to make good judgement calls
- Keep it concise — every token in a skill is spent on every invocation
