# Memory-Domain Research Atlas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce three research documents (`atlas.md`, `combinations.md`, `domain-recipes.md`) that catalog memory/retrieval ideas, identify viable combinations, and propose per-domain stacks for Chat / KB / Silentium — with explicit prior-art mapping to this repo's existing phases.

**Architecture:** Research-only deliverable. No code. Work proceeds in three layers: (1) prior-art sweep of this repo's memory and commits to avoid rediscovery, (2) external paper reading organized by family, (3) synthesis into combinations and per-domain recipes. Each layer commits separately so the atlas can be reused even if recipes change.

**Tech Stack:** Markdown documents under `docs/research/`. Web research via WebSearch + WebFetch. Repo prior-art via Grep + Read against `~/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/` and `git log`. No runtime code paths are touched.

**Spec:** `docs/superpowers/specs/2026-04-20-memory-research-atlas-design.md`

---

## Operating principles for every task

- **No benchmarking.** This plan does not run evals, tune parameters, or write code under `src/`. Any step that feels like "let me just try it" is out of scope — log it as an open question in the recipes doc instead.
- **Plain language.** If a paper's key mechanism is stated as math, the atlas entry restates it as a mechanism a non-mathematician can follow. Keep the citation; translate the insight.
- **Prior-art first.** Before drafting an atlas entry for an external idea, check whether the repo already has a phase that touched it. If yes, the entry must reference the phase note or commit.
- **Commit per task.** Each task ends with a commit so the atlas is incrementally useful even if the plan is paused.
- **Docs directory.** All outputs live in `docs/research/` (create the directory in Task 1). The spec lives separately in `docs/superpowers/specs/`.

---

## File Structure

Files produced by this plan:

- Create: `docs/research/atlas.md` — main research substrate, ~25+ entries organized by family
- Create: `docs/research/combinations.md` — compounds, nullifications, conflicts
- Create: `docs/research/domain-recipes.md` — three recipes (Chat / KB / Silentium)
- Create: `docs/research/prior-art-index.md` — internal index of repo phases and Silentium work mapped to atlas entries (feeds the prior-art notes in the atlas)

Files not modified: no source files under `src/`, no configs, no existing docs other than the spec (which is frozen).

---

### Task 1: Scaffold documents and index

**Files:**
- Create: `docs/research/atlas.md`
- Create: `docs/research/combinations.md`
- Create: `docs/research/domain-recipes.md`
- Create: `docs/research/prior-art-index.md`

- [ ] **Step 1: Create `docs/research/` directory and atlas skeleton**

Contents of `docs/research/atlas.md`:

```markdown
# Memory & Retrieval Ideas Atlas

Living catalog of ideas drawn from the 2023–2026 memory/retrieval literature and from this repo's own phase work. Each entry follows a fixed schema (see spec `docs/superpowers/specs/2026-04-20-memory-research-atlas-design.md`).

## Schema

- **Name** — short, memorable.
- **Gist** — one sentence, plain English.
- **Insight** — why it works, translated from the paper's math into intuition.
- **Miss-mode killed** — one or more of: paraphrase, temporal, aggregation, context, schema, lexical, decomposition, granularity, analogy, sparse-precedent, compositional, scale.
- **Where it lives** — ingest / query / background.
- **Token cost** — none / 1-per-item / 1-per-query / many.
- **Pairs with** — other atlas entry names.
- **Conflicts with** — other atlas entry names.
- **Paper(s)** — citation + year.
- **Prior-art note** — pointer to repo phase note, commit, or "none".

## Families

### 1. Atomic-fact extraction and supersession
_(to be filled in Task 3)_

### 2. Structured graph / hypergraph retrieval
_(to be filled in Task 4)_

### 3. Query decomposition and planning
_(to be filled in Task 5)_

### 4. Re-ranking and late-interaction
_(to be filled in Task 6)_

### 5. Temporal reasoning over memory
_(to be filled in Task 7)_

### 6. Survey-depth families
_(to be filled in Task 8)_

### 7. Prior-art-derived entries
_(to be filled in Task 9)_
```

Contents of `docs/research/combinations.md`:

```markdown
# Combinations, Nullifications, and Conflicts

Analytical layer over `atlas.md`. No per-domain ranking here — those live in `domain-recipes.md`.

## Compounds worth trying
_(to be filled in Task 11)_

## Nullifications and redundancies
_(to be filled in Task 11)_

## Mechanical conflicts
_(to be filled in Task 11)_
```

Contents of `docs/research/domain-recipes.md`:

```markdown
# Per-Domain Recipes

Three proposed stacks drawing on `atlas.md` and `combinations.md`. No benchmark numbers here; those come from the plan that follows this research.

## Chat domain
_(to be filled in Task 12)_

## KB domain
_(to be filled in Task 13)_

## Silentium domain
_(to be filled in Task 14)_
```

Contents of `docs/research/prior-art-index.md`:

```markdown
# Prior-Art Index

Internal lookup table mapping this repo's phase notes and Silentium's experiments to atlas entries. Populated in Task 2; referenced by atlas entries in Tasks 3–9.

## Entries
_(to be filled in Task 2)_
```

- [ ] **Step 2: Commit scaffolding**

```bash
git add docs/research/
git commit -m "docs(research): scaffold atlas, combinations, recipes, prior-art index"
```

---

### Task 2: Prior-art sweep (repo and Silentium)

Goal: catalog every phase note, commit, and experiment already in this repo and Silentium that touches retrieval, memory, or ranking. This becomes the lookup the atlas entries reference in Tasks 3–9.

**Files:**
- Modify: `docs/research/prior-art-index.md`

- [ ] **Step 1: Enumerate memory-domain memory entries**

Run:

```bash
ls ~/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/
```

Read every file ending in `.md` except `MEMORY.md` itself. For each, extract: (a) the phase or topic, (b) the outcome (win / null / refuted / deferred), (c) the one-line mechanism that was tested.

- [ ] **Step 2: Enumerate recent commits touching retrieval or memory**

Run:

```bash
git log --oneline --since="2025-10-01" -- src/
```

Read every commit message. Flag ones that name a primitive (decay, rerank, fusion, graph, decomposition, etc.).

- [ ] **Step 3: Enumerate Silentium prior-art**

Ask the user for the Silentium repo path if not already known. Run the equivalent memory+git sweep there. If Silentium is not accessible in this session, mark its section as "pending user input" and continue — do not block the plan.

- [ ] **Step 4: Write the index**

For each item, add a row to `docs/research/prior-art-index.md` with this shape:

```markdown
### path_memory_phase214
- **Source:** `~/.claude/projects/-Users-kuindji-Projects--kuindji-memory-domain/memory/path_memory_phase214.md`
- **Topic:** session-decay retune
- **Outcome:** Outcome A' — decay=0.2 lifts tier-2 eval-B coherence 2/4 → 3/4
- **Mechanism:** exponential decay on session access recency, τ tuned on 13-row sweep
- **Likely atlas family:** 5 (temporal reasoning)
```

Produce one entry per memory file and per retrieval-relevant commit. Aim for 20–30 entries minimum (memory index already lists ~20).

- [ ] **Step 5: Commit**

```bash
git add docs/research/prior-art-index.md
git commit -m "docs(research): populate prior-art index from repo memory and git log"
```

---

### Task 3: Family 1 — atomic-fact extraction and supersession

Papers to read (search and fetch if not already familiar):

- Mem0 (2024) — "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory"
- Zep / Graphiti (2024) — "Zep: A Temporal Knowledge Graph Architecture for Agent Memory"
- Letta / MemGPT (2023) — "MemGPT: Towards LLMs as Operating Systems"
- A-Mem (2024) — "A-Mem: Agentic Memory for LLM Agents"
- MemoryBank (2023) — "MemoryBank: Enhancing Large Language Models with Long-Term Memory"

**Files:**
- Modify: `docs/research/atlas.md` (section "1. Atomic-fact extraction and supersession")

- [ ] **Step 1: Fetch and skim each paper**

Use WebSearch for the paper title + arxiv, then WebFetch on the arxiv abstract page. Read abstract, introduction, and the section(s) describing the memory mechanism. Do not read full experimental sections unless a mechanism is unclear.

- [ ] **Step 2: Write one atlas entry per distinct mechanism**

For each distinct mechanism (not one per paper — papers may share mechanisms), write an atlas entry under section 1. Use the schema from Task 1 verbatim. Expected entries (minimum): atomic-fact extraction, supersession rules, context-aware retrieval, hierarchical memory with paging, reflection/summary-over-facts.

Example entry shape:

```markdown
#### Atomic-fact extraction (Mem0-style)

- **Gist:** At ingest, a small LLM rewrites each turn into a list of standalone facts shaped as "subject — predicate — object — timestamp".
- **Insight:** A conversational turn rarely retrieves well because it mixes several claims and a lot of pragmatic fluff. Splitting into atoms lets each fact be embedded, scored, superseded, and returned independently. The retriever never has to pick the whole turn over another whole turn; it picks facts.
- **Miss-mode killed:** aggregation, paraphrase (partial). Does not kill context-frame miss on its own.
- **Where it lives:** ingest.
- **Token cost:** 1 small LLM call per ingested turn.
- **Pairs with:** supersession rules, entity canonicalization, query-time decomposition.
- **Conflicts with:** hierarchical summary trees (they disagree on what a "memory unit" is — runnable together only by keeping two indices).
- **Paper(s):** Mem0 (2024); MemoryBank (2023) uses a related but coarser variant.
- **Prior-art note:** `inbox_error_handling.md` and `project_inbox_redesign.md` — this repo's inbox already does a form of claim assertion at ingest; the atomic-fact framing is the external vocabulary for what's already happening.
```

- [ ] **Step 3: Check every entry against the prior-art index**

For each atlas entry written, grep `docs/research/prior-art-index.md` for related topics. If a prior-art entry exists, add a prior-art note referencing it. If none exists, write "none" explicitly — do not omit the field.

- [ ] **Step 4: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): atlas family 1 — atomic-fact extraction and supersession"
```

---

### Task 4: Family 2 — structured graph / hypergraph retrieval

Papers:

- GraphRAG (Microsoft, 2024) — "From Local to Global: A Graph RAG Approach to Query-Focused Summarization"
- HippoRAG (2024) — "HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models"
- HippoRAG 2 (2025) — successor paper if available; search arxiv for "HippoRAG 2"
- LightRAG (2024) — "LightRAG: Simple and Fast Retrieval-Augmented Generation"

**Files:**
- Modify: `docs/research/atlas.md` (section "2. Structured graph / hypergraph retrieval")

- [ ] **Step 1: Fetch and skim each paper**

Same procedure as Task 3. Pay particular attention to: edge-construction strategy (LLM-proposed vs. rule-based), traversal algorithm (BFS / personalized PageRank / random walk), entity canonicalization strategy.

- [ ] **Step 2: Write atlas entries**

Expected entries (minimum): LLM-proposed edge extraction, entity-anchored BFS retrieval, personalized-PageRank retrieval over memory graphs, community summaries (GraphRAG), hypergraph retrieval (if LightRAG's representation qualifies). Follow schema from Task 1.

- [ ] **Step 3: Prior-art cross-reference**

Strong expected hits on `path_memory_phase*` entries — path-memory IS a form of graph retrieval. Every entry here must link to the relevant phase notes.

- [ ] **Step 4: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): atlas family 2 — structured graph retrieval"
```

---

### Task 5: Family 3 — query decomposition and planning

Papers:

- Self-Ask (2023) — "Measuring and Narrowing the Compositionality Gap in Language Models"
- IRCoT (2023) — "Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions"
- Plan×RAG (2024) — search arxiv for the latest
- Step-Back Prompting (2024) — Google — "Take a Step Back: Evoking Reasoning via Abstraction in Large Language Models"

**Files:**
- Modify: `docs/research/atlas.md` (section "3. Query decomposition and planning")

- [ ] **Step 1: Fetch and skim each paper**

Focus: how is the decomposition itself generated (LLM prompt vs. parser), how is fanout bounded, how are sub-results fused.

- [ ] **Step 2: Write atlas entries**

Expected entries (minimum): sub-question fanout, interleaved CoT retrieval, abstract-then-retrieve (step-back), planner-led retrieval. Schema from Task 1.

- [ ] **Step 3: Prior-art cross-reference**

Likely hits: `kb_decomposition_next_steps.md`, `kb_architecture_testing.md`. The repo's KB work already explored a form of this.

- [ ] **Step 4: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): atlas family 3 — query decomposition"
```

---

### Task 6: Family 4 — re-ranking and late-interaction

Papers:

- ColBERT-v2 (2022) — "ColBERTv2: Effective and Efficient Retrieval via Lightweight Late Interaction"
- RankLLM / RankGPT (2023) — "Zero-Shot Listwise Document Reranking with a Large Language Model"
- Cross-encoder MS-MARCO rerankers — survey-level (bge-reranker-v2, Cohere-rerank-3)
- LLM-as-reranker variants (2024) — any recent paper on LLM-based reranking, WebSearch for "LLM reranker 2024 arxiv"

**Files:**
- Modify: `docs/research/atlas.md` (section "4. Re-ranking and late-interaction")

- [ ] **Step 1: Fetch and skim each paper**

Focus: late-interaction math in plain terms, listwise vs. pointwise rerank, cost-per-candidate.

- [ ] **Step 2: Write atlas entries**

Expected entries (minimum): late-interaction (ColBERT), cross-encoder rerank, listwise LLM rerank, score-fusion rerank. Schema from Task 1.

- [ ] **Step 3: Prior-art cross-reference**

Likely hits: `path_memory_phase216.md` (same-family RRF — a form of score fusion), earlier phase notes on reranking if any.

- [ ] **Step 4: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): atlas family 4 — reranking and late-interaction"
```

---

### Task 7: Family 5 — temporal reasoning over memory

Papers:

- TimeRAG / temporal RAG variants — WebSearch "temporal RAG arxiv 2024"
- Zep / Graphiti's temporal KG section (revisit from Task 3)
- Mem0's decay scheduler (revisit from Task 3)
- Temporal knowledge graph surveys — WebSearch for a recent survey

**Files:**
- Modify: `docs/research/atlas.md` (section "5. Temporal reasoning over memory")

- [ ] **Step 1: Fetch and skim**

Focus: how is "when" modeled separately from "what", decay functions (exponential / stretched / step), event-valid-interval vs. ingest-time-only.

- [ ] **Step 2: Write atlas entries**

Expected entries (minimum): exponential-decay recency, event-valid-time intervals, bitemporal memory (ingest-time vs. valid-time separately), supersession-by-time-of-claim. Schema from Task 1.

- [ ] **Step 3: Prior-art cross-reference**

Strong expected hits: `path_memory_phase214.md` (decay=0.2), `2026-04-12-chat-temporal-validity-and-semantic-dedup.md` (spec). Every entry here must link.

- [ ] **Step 4: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): atlas family 5 — temporal reasoning"
```

---

### Task 8: Survey-depth families (6–9)

Papers — one-line gist each, no deep read unless a later recipe demands it:

- RAPTOR (2024), MemTree — hierarchical summary trees
- SPIRES, KGGen, Triplex — entity/claim canonicalization
- HyDE (2022), Query2Doc (2023), step-back — query expansion / rewriting (step-back already in Task 5, do not duplicate)
- Self-RAG (2023), CRAG (2024), Adaptive-RAG (2024), FLARE (2023) — agentic iterative retrieval

**Files:**
- Modify: `docs/research/atlas.md` (section "6. Survey-depth families")

- [ ] **Step 1: One stub entry per mechanism**

Each stub has: name, gist (one sentence), miss-mode killed, where it lives, paper citation, prior-art note (or "none"). Skip the insight and conflicts fields for stubs — these expand to full entries only if a recipe pulls them in.

- [ ] **Step 2: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): atlas families 6-9 — survey stubs"
```

---

### Task 9: Prior-art-derived atlas entries

Walk the prior-art index and write atlas entries for ideas this repo or Silentium tried that are not yet covered in families 1–5. Each such entry treats the phase note as the primary "paper".

**Files:**
- Modify: `docs/research/atlas.md` (section "7. Prior-art-derived entries")

- [ ] **Step 1: Identify uncovered prior-art**

For each prior-art-index entry, check whether an atlas entry in families 1–8 already captures its mechanism. If not, flag it as a candidate.

- [ ] **Step 2: Write atlas entries for candidates**

Each entry notes the outcome (win / null / refuted). Refuted mechanisms get entries too — a refutation is as useful as a confirmation. Example:

```markdown
#### SYNAPSE spreading-activation (refuted)

- **Gist:** Query-time activation spreads from anchor nodes to neighbors with inhibition between tiers.
- **Insight:** Idea is that a concept activates related concepts proportionally to edge weight, discounted by hop distance.
- **Miss-mode claimed to kill:** analogy, context.
- **Outcome in this repo:** refuted — Phase 2.10 (`path_memory_phase210.md`). Small-graph dilution and tier-2 inhibition cause regressions; ships opt-in only.
- **Token cost:** none (pure graph math).
- **Pairs with:** (n/a — refuted).
- **Conflicts with:** (n/a — refuted).
- **Paper(s):** cognitive-psychology literature on spreading activation; this repo's Phase 2.10 tried a SYNAPSE variant.
- **Prior-art note:** `path_memory_phase210.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): atlas family 7 — prior-art-derived entries"
```

---

### Task 10: Miss-mode coverage audit

Goal: confirm every miss-mode in the taxonomy has at least one atlas entry claiming to kill it. Flag any uncovered miss-mode as a research gap inside the atlas.

**Files:**
- Modify: `docs/research/atlas.md` (add an appendix)

- [ ] **Step 1: Build the coverage table**

For each miss-mode (paraphrase, temporal, aggregation, context, schema, lexical, decomposition, granularity, analogy, sparse-precedent, compositional, scale), grep the atlas for entries that claim to kill it. Record entry names.

- [ ] **Step 2: Append the table to the atlas**

Under a new section "Appendix — Miss-mode coverage":

```markdown
## Appendix — Miss-mode coverage

| Miss-mode | Entries that claim to kill it |
|---|---|
| paraphrase | atomic-fact extraction, HyDE, ... |
| temporal | exponential-decay recency, bitemporal memory, ... |
| ... | ... |

### Research gaps

_Miss-modes with zero entries:_ (list here, or "none" if all covered)
```

- [ ] **Step 3: Commit**

```bash
git add docs/research/atlas.md
git commit -m "docs(research): miss-mode coverage audit"
```

---

### Task 11: Combinations doc

**Files:**
- Modify: `docs/research/combinations.md`

- [ ] **Step 1: Draft compounds**

Write at least 5 compounds. Each follows this shape:

```markdown
### Atomic-fact extraction + query-time decomposition

- **Atlas entries:** atomic-fact extraction (family 1); sub-question fanout (family 3).
- **Why it compounds:** extraction kills aggregation misses on the write side (multi-fact turns become multi-atom); decomposition kills them on the read side (multi-fact questions become multi-query). Belt and braces for the hardest miss mode.
- **Token cost:** 1 small LLM per ingest + 1 small LLM per query.
- **Best-fit domain:** Chat (ingest-heavy), with a query-side boost for complex questions.
```

- [ ] **Step 2: Draft nullifications**

Write at least 3. Each names two atlas entries and states why stacking buys nothing.

- [ ] **Step 3: Draft mechanical conflicts**

Name pairs that disagree on the unit of memory or the shape of the index. At least 1, ideally 2–3.

- [ ] **Step 4: Commit**

```bash
git add docs/research/combinations.md
git commit -m "docs(research): combinations, nullifications, conflicts"
```

---

### Task 12: Chat domain recipe

**Files:**
- Modify: `docs/research/domain-recipes.md` (section "Chat domain")

- [ ] **Step 1: Write domain sketch**

One paragraph. What Chat stores (user utterances, model replies, derived facts), typical queries (follow-up questions, long-horizon recall of user preferences, temporal retrievals), what a miss means in product terms (user says "you already know this" or gets stale info).

- [ ] **Step 2: Specify the non-AI backbone**

Name one encoder, one index, one ranker, one temporal primitive — all drawn from atlas entries. Justify each choice in one or two sentences.

- [ ] **Step 3: State the ceiling**

List at least one miss-mode the backbone cannot kill, with reasoning. Do not claim zero ceiling.

- [ ] **Step 4: Specify haiku insertion points**

At most 2. Ingest-side preferred (Chat is category A per the user's domain mapping). Each includes: what it does, why no algorithm replaces it, token cost per ingested turn, plausible recall delta. If a proposed insertion point fails the total-tokens test, remove it.

- [ ] **Step 5: Write "Relation to this repo"**

Map to current state: which phases / commits the recipe extends, which defaults would change, which prior experiments the recipe inherits wins or losses from. Concrete pointers only — phase numbers, file names, commit hashes.

- [ ] **Step 6: List 2–3 open questions**

Genuine empirical unknowns, not TODOs. Examples: "Does atomic-fact extraction at ingest cost more than the decomposition it replaces at query?" "Does bitemporal memory help or hurt eval-B coherence given the Alexander-succession null?"

- [ ] **Step 7: Commit**

```bash
git add docs/research/domain-recipes.md
git commit -m "docs(research): Chat domain recipe"
```

---

### Task 13: KB domain recipe

Same structure as Task 12, but for KB (structured data, schema-bearing, queries tend to be compositional).

**Files:**
- Modify: `docs/research/domain-recipes.md` (section "KB domain")

- [ ] **Step 1:** Domain sketch.
- [ ] **Step 2:** Non-AI backbone (expected tilt: stronger lexical / BM25 presence than Chat, explicit schema-aware retrieval).
- [ ] **Step 3:** Ceiling statement.
- [ ] **Step 4:** Haiku insertion points — at most 2, ingest-side preferred (KB is category A). Plausible candidates: canonicalization at ingest, schema-aware claim typing.
- [ ] **Step 5:** Relation to repo — hit `kb_architecture_testing.md`, `kb_decomposition_next_steps.md`, `kb_scoring_harness_location.md`.
- [ ] **Step 6:** 2–3 open questions.
- [ ] **Step 7: Commit**

```bash
git add docs/research/domain-recipes.md
git commit -m "docs(research): KB domain recipe"
```

---

### Task 14: Silentium domain recipe

Same structure, but Silentium is category B (query-heavy). Haiku insertions tilt to the query side.

**Files:**
- Modify: `docs/research/domain-recipes.md` (section "Silentium domain")

- [ ] **Step 1:** Domain sketch — long historical traces, predictive use, analogy-heavy queries.
- [ ] **Step 2:** Non-AI backbone (expected tilt: graph retrieval with temporal primitives, scale-aware candidate pools).
- [ ] **Step 3:** Ceiling statement.
- [ ] **Step 4:** Haiku insertion points — at most 2, query-side preferred. Plausible candidates: query decomposition for compositional queries, abstract-then-retrieve (step-back) for analogy queries.
- [ ] **Step 5:** Relation to repo — hit `path_memory_phase75.md` (LOCOMO/MSC), `path_memory_strategic_review.md`, recent path-memory phases.
- [ ] **Step 6:** 2–3 open questions.
- [ ] **Step 7: Commit**

```bash
git add docs/research/domain-recipes.md
git commit -m "docs(research): Silentium domain recipe"
```

---

### Task 15: Success-criteria review and final commit

Goal: verify the research meets every criterion in spec §Success criteria before declaring the deliverable done.

**Files:**
- Modify: `docs/research/atlas.md` (possibly), `docs/research/combinations.md` (possibly), `docs/research/domain-recipes.md` (possibly)

- [ ] **Step 1: Check atlas coverage**

Count entries per family. Confirm ≥1 entry per deep family (1–5) and ≥1 stub per survey family (6–9). Confirm total ≥25 entries. If short, add the missing entries before proceeding.

- [ ] **Step 2: Check miss-mode coverage**

Confirm the appendix table from Task 10 shows every miss-mode covered. If any are uncovered and it is feasible to add an entry, do so; otherwise confirm the gap is explicitly flagged.

- [ ] **Step 3: Check combinations viability**

Count compounds (≥5), nullifications + conflicts (≥3 combined). If short, add more.

- [ ] **Step 4: Check recipes actionability**

For each of the three recipes, confirm: named backbone, ≤2 haiku insertion points, "relation to repo" paragraph with concrete pointers, 2–3 open questions, ≥1 stated ceiling. Fix any missing piece inline.

- [ ] **Step 5: Check prior-art coverage**

Sample-grep: pick 10 atlas entries at random and confirm each has a prior-art note (either a pointer or explicit "none"). Fix any that violate.

- [ ] **Step 6: Write a "Done" summary into `domain-recipes.md`**

Append a short closing section:

```markdown
## Research status

All success criteria met (see spec §Success criteria). The next step is a separate brainstorming + planning round that picks one recipe to prototype against a specific eval (LOCOMO, MSC, or internal tier-N). This document is input to that round, not a commitment to a winner.
```

- [ ] **Step 7: Commit**

```bash
git add docs/research/
git commit -m "docs(research): success-criteria review, mark research complete"
```

---

## Out of scope (do not do in this plan)

- Running any benchmark (LOCOMO, MSC, internal tier-N).
- Writing prototype code under `src/`.
- Tuning any parameter or re-running any sweep.
- Picking a single winning recipe.
- Committing to which primitives become framework-level APIs.

All of the above belong to the next planning round, which this research feeds.
