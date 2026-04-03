# KB Architecture Testing Loop — Design Spec

## Goal

Test and optimize the Knowledge Base domain's write path (inbox processing, consolidation) and read path (buildContext, ask) to maximize two opposing objectives: **answer quality** and **response speed**.

Quality is measured by whether buildContext() provides enough context for a downstream LLM (Haiku) to answer questions it would otherwise get wrong. Speed is measured by wall-clock time per phase and per query.

## Dataset

### Topic: Byzantine Empire (330–1453 CE)

A deliberately obscure historical domain where Haiku is likely to hallucinate on specifics. Provides:
- Verifiable facts with specific dates, names, and cause-and-effect chains
- Natural supersession pairs (corrected/updated facts)
- Related knowledge clusters (same emperor/event from different angles)
- Theological, administrative, military, and economic sub-topics for cross-linking

### Entries: ~40-60 items

Most entries are **not pre-classified** — the inbox pipeline classifies them. A handful (~5) have pre-assigned classifications as control cases.

Each entry is tagged with metadata for traceability:
- `datasetId` — stable ID for cross-referencing with verification questions
- `expectedClassification` — what a reasonable classification would be (for scoring, not fed to the pipeline)
- `supersessionGroup` — entries that should form supersession chains
- `relatedGroup` — entries that should be linked as related knowledge

### Verification Questions: 15-20

Questions with known correct answers that Haiku would likely get wrong without KB context.

```typescript
interface VerificationQuestion {
  id: string;
  question: string;
  expectedAnswer: string;
  requiredEntryIds: string[];    // dataset entries that SHOULD appear in context
  excludedEntryIds: string[];    // superseded entries that should NOT appear
  difficulty: "easy" | "medium" | "hard";
}
```

Difficulty levels:
- **easy** — Haiku might partially know this (control group)
- **medium** — Haiku would struggle with specifics
- **hard** — Haiku would almost certainly hallucinate

## Architecture Configs

### Pipeline Variants

Each variant controls which inbox processing stages run:

| Config | Classify | Tag | Topic-Link | Supersede | Relate |
|--------|----------|-----|------------|-----------|--------|
| `full-pipeline` | yes | yes | yes | yes | yes |
| `no-relations` | yes | yes | yes | yes | no |
| `no-supersession` | yes | yes | yes | no | no |
| `minimal` | yes | yes | no | no | no |

Stages 1 (classify) and 2 (tag) are always on — they're the minimum for the KB to function.

### Search Weight Variants

| Config | Vector | Fulltext | Graph |
|--------|--------|----------|-------|
| `hybrid-default` | 0.5 | 0.3 | 0.2 |
| `vector-heavy` | 0.7 | 0.2 | 0.1 |
| `fulltext-heavy` | 0.2 | 0.7 | 0.1 |
| `graph-heavy` | 0.2 | 0.2 | 0.6 |

### Consolidation Variants

- `consolidation-on` — run consolidation before retrieval testing
- `consolidation-off` — test raw entries only

### Context Budget Variants

- `budget-small` — 1000 tokens
- `budget-medium` — 2000 tokens
- `budget-large` — 4000 tokens

### Selected Configs (~10-12)

Not the full 96-combination matrix. Priority configs:

1. `full-pipeline` + `hybrid-default` + `consolidation-off` + `budget-medium` (baseline full)
2. `full-pipeline` + `hybrid-default` + `consolidation-on` + `budget-medium` (consolidation impact)
3. `minimal` + `hybrid-default` + `consolidation-off` + `budget-medium` (pipeline cost/benefit)
4. `no-relations` + `hybrid-default` + `consolidation-off` + `budget-medium` (relations value)
5. `no-supersession` + `hybrid-default` + `consolidation-off` + `budget-medium` (supersession value)
6. `full-pipeline` + `vector-heavy` + `consolidation-off` + `budget-medium` (search mode comparison)
7. `full-pipeline` + `fulltext-heavy` + `consolidation-off` + `budget-medium`
8. `full-pipeline` + `graph-heavy` + `consolidation-off` + `budget-medium`
9. `full-pipeline` + `hybrid-default` + `consolidation-off` + `budget-small` (budget impact)
10. `full-pipeline` + `hybrid-default` + `consolidation-off` + `budget-large`
11. `full-pipeline` + `hybrid-default` + `consolidation-on` + `budget-large` (best quality attempt)
12. `no-kb-baseline` — ask() with empty KB, establishes Haiku's floor

## Phased Loop Structure

### Phases

```
Phase 0: Collect Data
  Input: none (fetches from Wikipedia)
  Output: checkpoints/dataset.json
  Contains: entries[], verificationQuestions[]

Phase 1: Ingest
  Input: dataset.json + config
  Output: checkpoints/<config>/ingested.json
  Contains: memoryIdMap (datasetId → memoryId), timing, entry count

Phase 2: Process Inbox
  Input: ingested.json
  Output: checkpoints/<config>/processed.json
  Contains: per-entry classification, edges created, timing per stage
  Fail-fast: if >50% entries fall back to default "fact" classification

Phase 3: Consolidate (optional)
  Input: processed.json
  Output: checkpoints/<config>/consolidated.json
  Contains: clusters found, merges performed, timing
  Skipped: if config.consolidate === false

Phase 4: Evaluate Retrieval
  Input: processed.json or consolidated.json + dataset.json
  Output: checkpoints/<config>/evaluation.json
  Contains: per-question { context, answer, memoriesReturned, timing }
  Fail-fast: if any question gets 0 relevant memories returned

Phase 5: Score
  Input: evaluation.json + dataset.json
  Output: checkpoints/<config>/scores.json
  Contains: per-question score (0-5), aggregate metrics
  Judge: Opus (the agent running the loop), NOT Haiku
  Fail-fast: if avgScore < baseline (no-KB) score

Phase 6: Report
  Input: scores.json across all configs
  Output: checkpoints/report.json
  Contains: comparative table, recommendations, next iteration suggestions
```

### Checkpoint Format

Each checkpoint is a JSON file with:

```typescript
interface Checkpoint {
  phase: number;
  config: string;
  timestamp: string;
  duration: number;        // wall-clock ms
  status: "success" | "failed" | "stopped";
  failReason?: string;
  data: Record<string, unknown>;  // phase-specific payload
}
```

### Fail-Fast Gates

| After Phase | Check | Stop If |
|-------------|-------|---------|
| 2 | Classification distribution | >50% default to "fact" |
| 2 | Edge creation | 0 supersession or relation edges when expected |
| 4 | Context relevance | Any question gets 0 relevant memories |
| 5 | Score vs baseline | avgScore <= baseline avgScore |

## Scoring

### Per-Question Scoring (0-5)

Judged by Opus, given: question, expected answer, actual answer.

- **0** — completely wrong or hallucinated
- **1** — vaguely related but incorrect specifics
- **2** — partially correct, missing key details
- **3** — mostly correct, minor inaccuracies
- **4** — correct with good detail
- **5** — correct and comprehensive

### Aggregate Metrics Per Config

| Metric | Formula | Purpose |
|--------|---------|---------|
| `avgScore` | mean(questionScores) | Quality |
| `avgTime` | mean(buildContext + ask latency) | Speed |
| `qualityPerSecond` | avgScore / avgTime | Tradeoff |
| `contextRelevance` | % of returned memories in requiredEntryIds | Precision |
| `contextNoise` | % of returned memories NOT in requiredEntryIds | Noise |
| `supersessionAccuracy` | % of superseded entries correctly excluded | Write path quality |
| `classificationAccuracy` | % matching expectedClassification | Pipeline quality |
| `ingestTime` | total Phase 1+2+3 time | Write path speed |

### Baseline

First config run is always `no-kb-baseline`: ask Haiku the verification questions with no context. This establishes the floor. Any config that doesn't beat it is broken or counterproductive.

## Implementation: Pipeline Variants

The KB domain's `processInboxBatch` in `src/domains/kb/inbox.ts` is refactored to accept a stage config:

```typescript
interface KbPipelineStages {
  classify: boolean;
  tagAssign: boolean;
  topicLink: boolean;
  supersede: boolean;
  relateKnowledge: boolean;
}
```

This is passed via `KbDomainOptions` and defaults to all-true (preserving current behavior). The test configs create modified KB domains with different stage flags.

This modification lives only in the worktree and is discarded before merging to main.

## Directory Structure

```
tests-integration/kb-architecture/
  run.ts                          # orchestrator CLI
  configs.ts                      # architecture config definitions
  types.ts                        # shared types (Checkpoint, PipelineConfig, etc.)
  dataset.json                    # generated once by Phase 0
  phases/
    0-collect.ts                  # fetch Wikipedia data, build entries + questions
    1-ingest.ts                   # create engine, ingest entries
    2-process.ts                  # drain inbox with pipeline variant
    3-consolidate.ts              # run consolidation schedule
    4-evaluate.ts                 # run verification questions through buildContext/ask
    5-score.ts                    # Opus-judged scoring
    6-report.ts                   # comparative analysis
  checkpoints/
    no-kb-baseline/
    full-pipeline-hybrid-default-noconsolidate-2000/
    minimal-hybrid-default-noconsolidate-2000/
    ... (one dir per config)
```

### Orchestrator CLI

```
bun run tests-integration/kb-architecture/run.ts [options]

Options:
  --config <name>       Run a specific config (default: all selected configs)
  --from-phase <n>      Resume from phase N (reads existing checkpoints)
  --only-phase <n>      Run only phase N
  --baseline            Run baseline (no-KB) evaluation only
  --report              Generate comparative report from existing checkpoints
  --collect             Run Phase 0 only (data collection)
```

## Loop Workflow

1. Run `--collect` once to build dataset
2. Run `--baseline` to establish Haiku's floor
3. Run configs sequentially or pick specific ones with `--config`
4. After each config, inspect checkpoints — stop early if failing
5. Run `--report` to compare all completed configs
6. Review report, adjust configs or pipeline code
7. Re-run from Phase 1 (dataset stays stable)

## What This Does NOT Test

- Different embedding models (only ONNX/MiniLM)
- Different LLM adapters (only Claude CLI)
- Multi-domain interaction (only KB + Topic)
- Concurrent inbox processing
- Large-scale performance (>100 entries)

These are out of scope for this iteration but could be added as future config axes.
