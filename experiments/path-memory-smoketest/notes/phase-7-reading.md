# Phase 7 reading note — LongMemEval retarget

Source: LongMemEval (arXiv:2410.10813, ICLR 2025). Plan: `PLAN-post-2.8.md`
§ Phase 7 retarget. Per `~/.claude/plans/tidy-shimmying-fiddle.md`, this
phase ships the adapter (loader + turn-to-claim ingestion + retrieval +
dry-run) **plus rule-based scoring**. The only deferred piece is the
LLM-as-judge integration (Phase 7.2), which gates apples-to-apples peer
comparison but is not required to iterate on path-memory configs.

## Dataset format expected by the loader

The loader (`data/longmemeval-loader.ts`) is strict: missing fields raise
before ingestion, so schema drift fails loudly. The expected top-level
JSON is an array of question objects with these fields:

| field                   | type                          | notes |
|-------------------------|-------------------------------|-------|
| `question_id`           | string                        | stable across reruns; used to seed deterministic claim ids |
| `question_type`         | string                        | one of the five LongMemEval task categories (see below) |
| `question`              | string                        | the evaluation question; becomes the retrieval probe |
| `answer`                | string                        | gold answer; stored but not consumed in Phase 7 |
| `haystack_sessions`     | `Array<Array<Turn>>`          | outer index = session, inner = turn order within session |
| `haystack_session_ids`  | `string[]`                    | length must equal `haystack_sessions.length` |
| `haystack_dates`        | `string[]`                    | `Date.parse`-able; typically day-granular (`YYYY-MM-DD`) |
| `answer_session_ids`    | `string[]` (optional)         | which sessions contain the gold answer; informational |

Each `Turn` is `{ role: "user" | "assistant", content: string }`. Any
other role (e.g. `"system"`) is rejected — the benchmark does not include
system turns in the haystack.

Place the file at `experiments/path-memory-smoketest/data/longmemeval-s.json`
or pass a custom path to the dry-run script. The file is gitignored.

Distribution: https://github.com/xiaowu0162/LongMemEval (follow the repo's
release notes for the current LongMemEval-S archive and license terms).

## Task categories (what each stresses)

1. **single-session-user** — a fact from a single user turn in one
   session. Tests whether the retriever reaches a per-turn claim when
   the probe contains near-verbatim cues.
2. **single-session-assistant** — same as above, but the fact is in an
   assistant turn. Stresses whether we benefit from
   `includeAssistantTurns: true` at ingestion (default on).
3. **single-session-preference** — preferences/opinions stated across
   multiple turns within one session. Stresses within-session clustering
   (same cluster as Greek-history eval-B).
4. **multi-session** — fact that requires recall across two or more
   sessions. Stresses cross-session bridging — our temporal + lexical
   edges have to span session boundaries. Phase 2.9 edge-concentration
   was measured on a Greek-history proxy; LongMemEval is the real test.
5. **temporal-reasoning** — timeline questions ("before X / after Y /
   when did Z"). This is the category Phase 2.11's router was designed
   to exploit. Phase 7's output is a prerequisite for the 2.11 retry.

LongMemEval also includes an "abstention" sub-task where no evidence
exists in the haystack; the correct retrieval behavior is to surface
low-confidence / empty results. Phase 7 does not score this — the
retriever returns whatever paths it finds and the downstream judge
handles abstention.

## Ingestion decisions (Phase 7)

- **One claim per conversational turn.** No fact extraction, no
  sentence splitting. The claim text = turn content; the claim id =
  `${questionId}-s${sessionIdx}-t${turnIdx}`. Idempotent.
- **Both roles ingested by default** (`includeAssistantTurns: true`).
  Assistant turns sometimes contain factual content users don't repeat
  verbatim. The option exists to flip this off in a follow-up ablation.
- **`validFrom` = sessionEpochSeconds + turnIdx.** Day-granular
  timestamps from `haystack_dates` are preserved; the 1-second
  per-turn offsets are opaque to LongMemEval questions (which reason at
  day granularity at best) and preserve intra-session monotonicity for
  our temporal layer.
- **No `supersedes` edges.** LongMemEval conversations don't encode
  explicit fact supersession in a way we can read without LLM
  extraction. Knowledge-update questions land in the retrieval layer
  via recency scoring, not via the temporal-supersession path.
- **Fresh `PathMemory` per question.** LongMemEval's haystacks are
  per-question scoped. Matches the benchmark's intended evaluation
  semantics and avoids cross-question contamination.

## Retrieval decisions (Phase 7 dry-run)

- **Probe = `questionText` only.** No probe composition for this phase.
- **Default retrieval options** mirror the Phase 2.8 ship-default
  (`dijkstra`, `temporalHopCost=0.5`, `weighted-fusion` at `tau=0.2`,
  `anchorTopK=5`, `resultTopN=10`). Access-tracking is **off** by
  default for the dry-run to avoid noise in its observability.
- **Output** is `retrievedClaimIds` + `retrievedClaimTexts` per
  question, deduplicated across the top paths in rank order. This is
  the context any downstream scorer — rule-based or LLM — operates on.

## Scoring (rule-based, no LLM judge)

Path-memory doesn't generate answers; it returns retrieved claim
texts. The scoring in `eval/longmemeval-score.ts` measures whether the
retrieved context is **sufficient for a judge (LLM or human) to
produce the gold answer**, not whether the system itself produced one.
This is an internally-comparable signal across path-memory configs —
not apples-to-apples vs Memento/Zep numbers, which are GPT-4o-as-judge
over generated answers.

Per-question metrics (see `LongMemEvalMetricBundle`):

| metric                     | what it measures |
|----------------------------|------------------|
| `substringContainment`     | Lowercased gold-answer string appears verbatim in some retrieved claim. Strong signal for short factual answers. |
| `substringFirstRank`       | Rank of the first claim containing the gold substring, or `-1`. Diagnoses rank quality. |
| `fullTokenCoverage`        | Every stopword-filtered gold token appears in the retrieved context. |
| `tokenRecall`              | Fraction of gold tokens present in the context set. |
| `tokenF1`                  | Standard token F1 over the raw retrieved context (precision dragged down by long context; kept for completeness). |
| `goldTokenCount`           | Diagnostic: content-tokens in gold after stopword filter. |
| `contextTokenCount`        | Diagnostic: content-tokens in the concatenated retrieved context. |

Aggregates (per-category and overall) report containment rate, full
coverage rate, mean token recall, mean token F1, mean rank of the first
answer-bearing claim, and count of questions where no retrieved claim
contains the gold answer.

**Known rule-based-scoring limitations.** The containment metric
rewards literal string presence; it will miss paraphrase-style gold
answers (e.g., gold "received a promotion" vs context "was promoted").
Token recall partially compensates. Neither catches the abstention
sub-task (gold ≈ "cannot be determined" — correct behavior is empty
retrieval, but the scorer will mark it "retrieved nothing" regardless).
Treat these numbers as lower bounds on judge-scored accuracy.

## Out-of-session follow-ups

1. **Phase 7.2 — LLM-as-judge scoring.** Standard on LongMemEval is
   GPT-4o-as-judge over generated answers. Reproducing peer numbers
   requires the same model. Sonnet or Opus would produce
   internally-comparable numbers but not external-comparable ones;
   document the choice explicitly in the first scored run. Without the
   judge, path-memory configs are compared via the rule-based
   aggregates above.
2. **Phase 2.11 retry.** Re-run `scripts/phase-2.11-router-dryrun.ts`
   (adapted to read LongMemEval probes via the new loader) and confirm
   the router produces > 1 unique weight tuple on temporal-reasoning
   probes before wiring it into retrieval.
3. **Multi-session accumulation semantics.** Phase 7 flattens all
   sessions into a single ingestion pass. An alternative is per-session
   `createSession()` followed by a final question-only retrieval —
   gives per-session probe accumulation but loses the one-shot QA
   framing of the benchmark. Revisit if multi-session accuracy
   underperforms.
4. **LoCoMo secondary target** (Phase 7.5). Same adapter shape;
   different JSON field names. Small extension.
