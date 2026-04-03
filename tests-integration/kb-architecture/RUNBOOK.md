# KB Architecture Testing Loop — Runbook

## What This Is

A phased testing loop that measures KB domain quality vs speed across 12 architecture configs. Uses Byzantine Empire knowledge (obscure enough that Haiku hallucates without KB context) as test data.

## Current State

- All implementation is complete (14 files under `tests-integration/kb-architecture/`)
- Phase 0 (data collection) has been run: 34 entries, 15 verification questions in `checkpoints/dataset.json`
- All 451 existing unit tests pass
- No configs have been run yet — baseline and all configs are pending

## Directory Layout

```
tests-integration/kb-architecture/
  run.ts              — CLI orchestrator (entry point)
  types.ts            — shared type definitions
  configs.ts          — 12 architecture configs
  checkpoint.ts       — checkpoint read/write utils
  configurable-inbox.ts — KB inbox with per-stage toggles
  engine-factory.ts   — creates MemoryEngine per config variant
  phases/
    0-collect.ts      — Wikipedia data collection (already run)
    1-ingest.ts       — ingest entries into SurrealDB
    2-process.ts      — drain inbox, track classifications
    3-consolidate.ts  — optional knowledge consolidation
    4-evaluate.ts     — run buildContext + ask per question
    5-score.ts        — LLM-judged scoring (0-5)
    6-report.ts       — comparative table + recommendations
    baseline.ts       — Haiku without KB context (floor)
  checkpoints/
    dataset.json      — shared dataset (already exists)
    <config-name>/    — per-config checkpoint JSONs (created during runs)
    _report/          — final comparative report
```

## How To Run

All commands from worktree root:
`/Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop`

### Step 1: Run baseline (Haiku without KB)

```bash
bun run tests-integration/kb-architecture/run.ts --baseline
```

This asks Haiku all 15 questions with no context, then scores them. Establishes the floor.
Writes: `checkpoints/baseline-no-kb/` (phases 1, 2, 4, 5)

### Step 2: Run configs one at a time

Start with the most important config first:

```bash
# Full pipeline, default search weights, no consolidation, 2000 token budget
bun run tests-integration/kb-architecture/run.ts --config full-hybrid-noconsolidate-2000
```

Each config runs Phases 1-5 sequentially. Watch for:
- Phase 2: classification accuracy and fact ratio (>70% fact = fail-fast)
- Phase 4: any questions getting 0 memories = warning
- Phase 5: score summary (avgScore, Q/s, relevance)

### Step 3: Run remaining configs

Priority order (most informative comparisons first):

1. `full-hybrid-noconsolidate-2000` — baseline full pipeline (DONE in step 2)
2. `minimal-hybrid-noconsolidate-2000` — only classify+tag, measures pipeline value
3. `no-supersession-hybrid-noconsolidate-2000` — skips supersession+relations
4. `no-relations-hybrid-noconsolidate-2000` — skips only relations
5. `full-hybrid-consolidate-2000` — adds consolidation
6. `full-vector-heavy-noconsolidate-2000` — vector 0.7
7. `full-fulltext-heavy-noconsolidate-2000` — fulltext 0.7
8. `full-graph-heavy-noconsolidate-2000` — graph 0.6
9. `full-hybrid-noconsolidate-1000` — small budget
10. `full-hybrid-noconsolidate-4000` — large budget
11. `full-hybrid-consolidate-4000` — best quality attempt

Or run all at once (slow, many LLM calls):
```bash
bun run tests-integration/kb-architecture/run.ts
```

### Step 4: Generate report

```bash
bun run tests-integration/kb-architecture/run.ts --report
```

Prints a comparative table and writes `checkpoints/_report/report.json`.

### Step 5: Analyze and iterate

Read the report. Key metrics:
- **avgScore** — answer quality (0-5)
- **avgTime** — seconds per query
- **qualityPerSecond** — the tradeoff number (higher = better)
- **contextRelevance** — % of expected memories found in context
- **supersessionAccuracy** — % of superseded entries correctly excluded
- **classificationAccuracy** — how well the pipeline classified entries

If a config beats baseline significantly, its pipeline stages are worth keeping.
If configs with fewer stages score similarly to full pipeline, those stages can be removed for speed.

## The 12 Configs

| # | Name | Pipeline | Search Weights | Consolidate | Budget |
|---|------|----------|---------------|-------------|--------|
| 0 | baseline-no-kb | none | - | no | - |
| 1 | full-hybrid-noconsolidate-2000 | all 5 stages | v0.5/f0.3/g0.2 | no | 2000 |
| 2 | full-hybrid-consolidate-2000 | all 5 stages | v0.5/f0.3/g0.2 | yes | 2000 |
| 3 | minimal-hybrid-noconsolidate-2000 | classify+tag only | v0.5/f0.3/g0.2 | no | 2000 |
| 4 | no-relations-hybrid-noconsolidate-2000 | no stage 5 | v0.5/f0.3/g0.2 | no | 2000 |
| 5 | no-supersession-hybrid-noconsolidate-2000 | no stages 4+5 | v0.5/f0.3/g0.2 | no | 2000 |
| 6 | full-vector-heavy-noconsolidate-2000 | all 5 stages | v0.7/f0.2/g0.1 | no | 2000 |
| 7 | full-fulltext-heavy-noconsolidate-2000 | all 5 stages | v0.2/f0.7/g0.1 | no | 2000 |
| 8 | full-graph-heavy-noconsolidate-2000 | all 5 stages | v0.2/f0.2/g0.6 | no | 2000 |
| 9 | full-hybrid-noconsolidate-1000 | all 5 stages | v0.5/f0.3/g0.2 | no | 1000 |
| 10 | full-hybrid-noconsolidate-4000 | all 5 stages | v0.5/f0.3/g0.2 | no | 4000 |
| 11 | full-hybrid-consolidate-4000 | all 5 stages | v0.5/f0.3/g0.2 | yes | 4000 |

## Pipeline Stages

1. **Classify** — LLM classifies entries (fact/definition/how-to/reference/concept/insight)
2. **Tag & Attribute** — creates KB tags, assigns classification tags
3. **Topic Link** — extracts topics, links to Topic domain
4. **Supersession** — detects when new entries replace old ones
5. **Related Knowledge** — links related entries (prerequisite/example-of/contrast/elaboration)

## Fail-Fast Gates

- After Phase 2: if >70% entries classified as "fact" when classify is enabled, stop
- After Phase 4: warn if any question gets 0 relevant memories
- After Phase 5: if avgScore <= baseline, the config is worse than no KB

## Key Files To Read If Debugging

- `src/domains/kb/inbox.ts` — original inbox processing (5 stages)
- `src/domains/kb/kb-domain.ts` — buildContext with 3 sections, search rank/expand
- `src/core/engine.ts` — ask() multi-round search + synthesize
- `src/domains/kb/schedules.ts` — consolidateKnowledge()

## Notes

- Uses real Claude CLI (haiku) for all LLM calls — costs API credits
- Uses real ONNX embeddings (all-MiniLM-L6-v2, 384-dim)
- Each config creates a fresh in-memory SurrealDB instance
- Scoring uses haiku as judge (same model) — not ideal but pragmatic for automation
- The configurable inbox in `configurable-inbox.ts` is a copy of `src/domains/kb/inbox.ts` with stage toggles — discardable before merging to main
- Dataset stays stable across all config runs — only re-collect if entries need changing

## Task Context

- Task ID: a8d8ecf2-58d9-4186-84a1-6fe23d8bcd3a
- Branch: task/knowledge-base-architecture-testing-loop
- Worktree: /Users/kuindji/Projects/@kuindji/memory-domain/.worktrees/knowledge-base-architecture-testing-loop
- Log commits with: `taskflow-cli log commit "<message>" --hash <hash>`
- Log findings with: `taskflow-cli log info "<text>"`
