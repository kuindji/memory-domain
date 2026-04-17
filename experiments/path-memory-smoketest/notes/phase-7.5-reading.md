# Phase 7.5 reading note — LOCOMO + MSC multi-dataset eval

Source plans: `PLAN-post-2.8.md` § "Phase 7 retarget" (Phase 7.5 is
the deferred secondary target called out there) and
`/Users/kuindji/.claude/plans/peaceful-frolicking-curry.md`.

Goal: run the current best-known path-memory config (Phase 2.14
defaults) against **two additional real benchmarks** — LOCOMO and MSC
— and produce aggregate scores alongside our existing LongMemEval
numbers. Every tuning decision since Phase 2.13 has landed on
LongMemEval alone; a single corpus shape has been driving production
defaults.

This is a **benchmark run**, not a harness build-out. Parsers and
scorers exist to feed the dry-run scripts; they get minimal unit
coverage (one loader test per dataset) and are validated by inspecting
dry-run output.

## Current best-known config (the thing under test)

Hard-coded into both dry-run scripts. Source of each value:

| field                   | value              | source                              |
|-------------------------|--------------------|-------------------------------------|
| encoder                 | BGE-base           | Phase 2.13 default (`path_memory_phase213`) |
| `traversal`             | `dijkstra`         | Phase 2.8 ship-default              |
| `temporalHopCost`       | 0.5                | Phase 2.8 ship-default              |
| `probeComposition`      | `weighted-fusion`  | Phase 2.8 ship-default              |
| `weightedFusionTau`     | 0.2                | Phase 2.8 ship-default              |
| `anchorTopK`            | 5                  | Phase 2.8 ship-default              |
| `resultTopN`            | 10                 | Phase 2.8 ship-default              |
| `sessionDecayTau`       | 0.2                | Phase 2.14 (`path_memory_phase214`) |
| `accessTracking`        | false              | Phase 3 observability off by default |
| spreading activation    | off                | Phase 2.10 Option O killed          |
| per-view router         | off                | Phase 2.11 deferred                 |
| edge-hotness soft-gate  | off                | Phase 4a refuted                    |
| claim ingestion         | one per turn, both roles, no supersedes | Phase 7 decision |

Per-script overrides via CLI are non-goals for v1 — if a dataset
needs a different knob (e.g. `sessionDecayTau=0` for MSC if synthetic
timestamps misbehave), it's edited in-script and documented here.

## Relation to existing systems

- **LongMemEval** — our existing Phase 7 harness
  (`eval/longmemeval-*.ts`, `data/longmemeval-loader.ts`,
  `scripts/phase-7-longmemeval-dryrun.ts`). This phase mirrors its
  file layout exactly.
- **SYNAPSE** (arXiv:2601.02744) — reports LoCoMo SOTA with GPT-4o
  judge + spreading activation. Our LOCOMO numbers are **not**
  apples-to-apples: rule-based scoring + Dijkstra traversal (Phase
  2.10 killed spreading activation in our architecture).
- **Mem0** — uses LOCOMO as its primary benchmark. We target the
  upstream `snap-research/locomo` JSON schema, not Mem0's derived
  format.
- **ParlAI MSC** — upstream is next-turn prediction; no QA. We
  repurpose MSC as a rule-based persona-recall probe (described
  below). This is a non-standard use; resulting numbers are
  internally comparable across path-memory configs only. No MSC
  leaderboard comparison.
- **Rule-based vs LLM-judge** — same Phase 7.2 caveat as LongMemEval:
  our metrics score whether retrieved context is **sufficient for a
  judge to answer**, not whether the system generated the answer.
  Judge integration is deferred per the "exhaust non-LLM first" rule.

## LOCOMO dataset

### Distribution
Source repo: `github.com/snap-research/locomo`
(tree/main/data/). License + release notes live upstream.
Place the JSON at `experiments/path-memory-smoketest/data/locomo.json`.
The file is gitignored.

### Schema (verified from upstream repo README)

Top-level: array of conversation objects:

| field             | type   | notes |
|-------------------|--------|-------|
| `sample_id`       | string | stable across reruns; prefix of all claim ids |
| `conversation`    | object | indexed sessions — see below |
| `qa`              | array  | question/answer/category/evidence quadruples |
| `observation`     | object | session-level generated observations (not consumed) |
| `session_summary` | object | generated summaries (not consumed) |
| `event_summary`   | object | annotated significant events (not consumed) |

`conversation` contains `session_1: Turn[]` + `session_1_date_time:
string` (ISO-ish), `session_2: Turn[]` + `session_2_date_time: string`,
… indexed from 1.

`Turn`:

| field          | type              | notes |
|----------------|-------------------|-------|
| `speaker`      | string            | speaker identifier |
| `dia_id`       | string            | dialog id, globally unique within the conversation; used as suffix in claim id |
| `text`         | string (optional) | dialog content |
| `img_url`      | string (optional) | for multimodal turns |
| `blip_caption` | string (optional) | auto-generated image caption |

`qa[i]`:

| field       | type                 | notes |
|-------------|----------------------|-------|
| `question`  | string               | retrieval probe |
| `answer`    | string               | gold |
| `category`  | string               | aggregation key |
| `evidence`  | `string[]` optional  | gold dia_ids whose turns contain the answer |

### Ingestion decisions

- **One claim per turn.** `id = "${sample_id}-${dia_id}"`. Uses
  `dia_id` rather than session/turn indexing because `dia_id` is the
  cross-reference key for `evidence`.
- **`text` preferred; `blip_caption` fallback.** If neither, skip the
  turn and bump a `skippedTurns` counter in loader output. Rationale:
  image-only turns without BLIP caption have no ingestible content.
- **`validFrom` = `Date.parse(session_N_date_time)/1000 + turnIdx`** —
  same 1-second monotonicity trick as LongMemEval. Timestamps carry
  session granularity; intra-session order is preserved via the offset.
- **No `supersedes` edges.** Same decision as Phase 7 — no LLM-based
  fact extraction without an LLM judge.
- **Fresh `PathMemory` per conversation** (not per question). LOCOMO's
  haystack is shared across all QA for a conversation — this is the
  key difference from LongMemEval's per-question haystack.

### Retrieval + scoring

- Probe = `qa[i].question` (single-probe, no composition).
- All retrieval options from the config table above.
- Scoring: reuses the LongMemEval metric bundle
  (`substringContainment`, `substringFirstRank`, `tokenRecall`,
  `tokenF1`, `fullTokenCoverage`) plus a LOCOMO-specific
  `evidenceRecall` metric:

  `evidenceRecall = |retrieved_claim_ids ∩ evidence_dia_ids| / |evidence_dia_ids|`

  Defined only when `evidence` is present. Claim ids are prefix-scoped
  (`${sample_id}-${dia_id}`), so matching strips the prefix before
  intersection.
- Aggregate by `qa[i].category`, same shape as LongMemEval's
  category aggregate.

## MSC dataset

### Distribution
HuggingFace mirror: `huggingface.co/datasets/nayohan/multi_session_chat`.
Distributed as parquet; convert to JSON once:

```python
# run once, not checked in
import polars as pl
df = pl.read_parquet("multi_session_chat/*.parquet")
df.write_json("data/msc.json")
```

Place at `experiments/path-memory-smoketest/data/msc.json`. Gitignored.

### Schema

Each row is one `(dialogue_id, session_id)` pair:

| field         | type      | notes |
|---------------|-----------|-------|
| `dataset`     | string    | e.g. "MSC" |
| `dialogue_id` | int64     | groups rows into one conversation (4 sessions each) |
| `session_id`  | int64     | 0..3 within a dialogue |
| `persona1`    | `string[]`| persona statements for speaker 1 (accumulate across sessions) |
| `persona2`    | `string[]`| persona statements for speaker 2 |
| `dialogue`    | `string[]`| utterances in order |
| `speaker`     | `string[]`| parallel array of "Speaker 1"/"Speaker 2" |

### Ingestion decisions

- Loader groups rows by `dialogue_id`, sorts by `session_id` (0..3).
- **One claim per utterance.** `id =
  "${dialogue_id}-s${session_id}-t${turnIdx}"`. `text = dialogue[i]`.
- **`validFrom` = synthetic counter.** MSC has no real timestamps. We
  use a per-dialogue synthetic base (fixed epoch: `0`) plus
  `session_id * 1_000_000 + turnIdx`. Intra-session monotonicity
  preserved; session ordering preserved; cross-dialogue comparison
  meaningless (fresh `PathMemory` per dialogue, so OK).
- **No `supersedes` edges** (same as Phase 7).
- **Fresh `PathMemory` per dialogue.**

### Persona-recall probe

MSC has no built-in QA. We repurpose persona statements as gold facts:
after ingesting all 4 sessions, for each dialogue we issue two probes
and score the retrieved context against the persona list.

Probes (hard-coded strings, configurable via adapter options):
- `"What do we know about Speaker 1?"`
- `"What do we know about Speaker 2?"`

For each probe:
1. Retrieve top paths with the config above.
2. Concatenate unique retrieved claim texts.
3. Tokenize with `src/tokenize.ts` (same stopword filter as LongMemEval).
4. `personaTokenRecall = |gold_tokens ∩ context_tokens| / |gold_tokens|`
   where `gold_tokens` = stopword-filtered tokens of the **final
   session's** `persona1` (resp. `persona2`) joined into a single
   string (final session carries the accumulated persona).
5. `substringContainmentRate` over individual persona statements:
   fraction of gold persona strings whose verbatim text appears in the
   retrieved context (weaker but precise signal).

Per-dialogue output = two recall + two containment numbers. Aggregate:
mean recall, median recall, % of dialogues with recall ≥ 0.8, mean
containment rate.

### Honest limitations

- Weak signal: persona facts are paraphrased in dialogue, not restated
  verbatim. Expect token recall to be bounded by how lexically the
  conversation encodes the persona.
- No single "correct retrieved set" — any claim that mentions the
  persona-relevant topic is legitimate. This is a **corpus-shape
  diagnostic** (does the retriever surface persona-relevant context at
  all?), not a leaderboard metric.
- Synthetic timestamps may interact oddly with `sessionDecayTau`. If
  MSC aggregates look anomalous, first fallback is
  `sessionDecayTau=0` for MSC only; record the override below.

## Results (2026-04-17 — first LOCOMO + MSC run, Phase 2.14 defaults)

| dataset       | n (scored/adv) | contain | fullCov | recall | F1    | evidR |
|---------------|----------------|---------|---------|--------|-------|-------|
| LOCOMO (full) | 1986 (1542/444)| 12.6%   | 18.1%   | 0.284  | 0.021 | 0.321 |

LOCOMO-10, all 10 conversations, 33 min wall-clock, 997ms/question avg
(dominated by ingestion: ~130s per conversation at ~210ms/claim). 87% of
scored questions have unreachable substring rank — most gold answers
are paraphrased, not quoted. Evidence recall at 32.1% shows the
retriever surfaces the right claim roughly 1/3 of the time even when
the text match fails.

Per-category (LOCOMO category integers not documented upstream;
interpretation is speculative):

| cat | n   | adv | scored | contain | fullCov | recall | F1    | evidR |
|-----|-----|-----|--------|---------|---------|--------|-------|-------|
| 1   | 282 |   0 |  282   |  3.5%   |  6.4%   | 0.184  | 0.020 | 0.114 |
| 2   | 321 |   0 |  321   |  2.2%   |  2.2%   | 0.082  | 0.005 | 0.416 |
| 3   |  96 |   0 |   96   |  3.1%   |  1.0%   | 0.095  | 0.013 | 0.147 |
| 4   | 841 |   0 |  841   | 20.7%   | 30.1%   | 0.417  | 0.029 | 0.372 |
| 5   | 446 | 444 |    2   |    —    |    —    |    —   |   —   |   —   |

Cat 4 dominates the corpus (42% of questions) and scores best. Cat 2
has the most distinctive profile — low text overlap, high evidence
recall (0.42) — consistent with multi-hop questions whose gold answer
is synthesized rather than lifted. Cat 5 is adversarial-only.

### MSC (100 dialogues, persona-recall probe)

| speaker   | probes | meanRecall | medianRecall | ≥80% | meanContain |
|-----------|--------|------------|--------------|------|-------------|
| Speaker 1 | 100    | 0.333      | 0.329        | 0.0% | 0.002       |
| Speaker 2 | 100    | 0.332      | 0.340        | 0.0% | 0.004       |
| combined  | 200    | 0.332      | 0.333        | 0.0% | 0.003       |

100 dialogues, 5 sessions each, 18.4 min wall-clock, 60 claims/dialogue
average. Mean persona token recall ≈ 33% — the retriever surfaces
persona-relevant context at roughly the expected rate given the
indirection (personas are paraphrased in dialogue, not restated).
Verbatim containment near 0% confirms personas are never quoted.

### Cross-dataset observations
- **Ingestion dominates wall-clock.** ~200ms/claim on BGE-base; 1986
  retrievals together took < 20% of total LOCOMO wall-clock.
- **Evidence recall > token recall on multi-hop-ish categories** (LOCOMO
  cat 2) — the graph retriever finds the right claim even when it
  lacks the surface tokens of the gold answer. This is exactly the
  capability path-memory is supposed to contribute over single-probe
  dense retrieval; first external evidence of it.
- **MSC recall is flat 33% across both speakers** — no Speaker 1 vs
  Speaker 2 asymmetry. Worth rerunning with speaker-specific probes
  to see if the probe phrasing is doing any work.

Raw dry-run outputs are written to
`data/phase-7.5-locomo-dryrun-output.json` and
`data/phase-7.5-msc-dryrun-output.json` (both gitignored).
