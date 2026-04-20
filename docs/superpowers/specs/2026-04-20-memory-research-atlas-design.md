# Memory-Domain Research: Ideas Atlas, Combinations, and Per-Domain Recipes

**Date:** 2026-04-20
**Status:** Design / spec (pre-implementation)
**Scope:** Research deliverable only — no code, no benchmarks, no picked winners.

## Motivation

The framework registers multiple memory domains (Chat, KB, Silentium). Each domain has different query shapes, different storage shapes, and different failure modes. A single retrieval pipeline cannot serve all three well; the framework's value is a catalog of composable primitives that each domain can assemble.

Prior work in this repo has advanced domain-specific retrieval phase-by-phase (path-memory 2.8 through 2.16, Phase 7.x LOCOMO/MSC baselines, predictive-memory Phase 1 null). That work proves the tuning surface is wide and the returns to better *primitives* now exceed the returns to further tuning of the current ones.

The governing principle: **LLM calls are justified only when they buy recall that no algorithm can, and only when the total token cost (including saved downstream calls) is lower than the non-LLM alternative.** Haiku-class calls sit at ingestion (Chat/KB) or query (Silentium), never speculatively.

Target: zero-miss retrieval per domain. All miss-modes are in scope; none are prioritized over others.

## Deliverables

Three linked documents. Code and prototypes are explicitly out of scope for this deliverable.

1. `docs/research/atlas.md` — primary research substrate. 20–40 idea entries from the literature, each ½–1 page, plain language. Living document.
2. `docs/research/combinations.md` — analytical layer over the atlas. Compounds worth trying, nullifications, mechanical conflicts.
3. `docs/research/domain-recipes.md` — three proposed stacks (Chat / KB / Silentium). Each names a non-AI backbone, the primitives layered on it, and the minimum set of haiku insertion points that earn their tokens.

### Why three documents and not one

The atlas is reusable across future domains and future sessions; it grows as papers appear and should not rot when a recipe changes. Combinations is pure analysis over the atlas — a separate doc because its claims depend on the atlas but not vice versa. Recipes are the actionable product artifact — keeping them separate prevents recipe churn from contaminating the research substrate.

## Atlas entry schema

Each entry in `atlas.md` has these fields:

- **Name** — short, memorable (e.g. "atomic-fact supersession", "query-time hypothetical document", "entity-anchored BFS").
- **One-sentence gist** — what it does, plain English.
- **The insight** — why it works, translated from the paper's math/framing into intuition. If the paper uses a scary equation, it is re-explained as a mechanism, not a formula.
- **Miss-mode it kills** — which kind of miss (paraphrase, temporal, aggregation, context, schema, lexical, decomposition, granularity, analogy, sparse-precedent, compositional, scale) the idea actually targets.
- **Where it lives** — ingestion-time, query-time, or scheduled background job.
- **Token cost** — none / one LLM call per item / one per query / many. Plain estimate.
- **What it pairs with** — short list of other atlas entries it combines with.
- **What it conflicts with** — ideas that nullify or contradict it.
- **Paper(s)** — citation + year, one-line provenance.
- **Prior-art note** — if this idea, or a close relative, was already tried in this repo or in Silentium, a pointer to the memory entry, commit hash, or phase note. Required for every entry where applicable.

The prior-art note is load-bearing: per the project convention that experimental plans must position existing systems, baking this into every atlas entry means the recipes doc inherits prior-art coverage for free.

## Combinations doc schema

`combinations.md` has three parts, no rankings across compounds.

1. **Compounds worth trying.** Each entry names 2–4 atlas ideas, states why they compound (typically: they hit orthogonal miss-modes, or one fixes a known failure of the other), estimates the token cost of the stack, and names the domain it is most likely to fit.
2. **Nullifications & redundancies.** Pairs where adding B on top of A buys nothing or actively hurts. This section saves downstream effort.
3. **Mechanical conflicts.** Pairs that cannot coexist cleanly without running two indices (e.g. hierarchical summary trees vs. atomic-fact stores disagree on "what is a unit of memory").

Ranking of compounds happens inside each domain recipe, not here.

## Per-domain recipe schema

`domain-recipes.md` contains three recipes (Chat / KB / Silentium), each ~1–2 pages, with these sections:

- **Domain sketch** — one paragraph on what the domain stores, what queries look like, what a miss means in product terms.
- **Non-AI backbone** — the best purely-algorithmic retrieval stack for this domain, assembled from atlas entries. Explicit choices: encoder, index structure, ranking, temporal/decay primitive. This is the floor; no LLM call is justified until the backbone is saturated.
- **Known ceiling of the backbone** — honest statement of which miss-modes the backbone cannot kill no matter how well-tuned, with reasoning.
- **Where haiku earns its tokens** — the minimum set of LLM insertion points. Each includes: what it does, why no algorithm replaces it, expected token cost per ingest or per query, and what recall delta is plausible. An insertion point that fails the "cheaper in total tokens than the recall it buys" test is not listed.
- **Relation to what's already in the repo** — explicit mapping to current state: which phase or commit the recipe extends or supersedes, what defaults would change, what dies. Required per the project's prior-art convention.
- **Open questions** — genuine empirical unknowns, not TODO placeholders.

Benchmark numbers are out of scope for this document; they come from the implementation plan that follows.

## Research scope

### Families covered in depth (full atlas entries, papers read)

1. Atomic-fact extraction + supersession — Mem0, Zep, Letta, A-Mem, MemoryBank.
2. Structured graph / hypergraph retrieval — GraphRAG, HippoRAG 1 & 2, LightRAG.
3. Query decomposition and planning — Self-Ask, IRCoT, Plan×RAG.
4. Re-ranking and late-interaction — ColBERT-v2, RankLLM, cross-encoder rerankers.
5. Temporal reasoning over memory — TimeRAG, temporal KGs, decay schedulers.

### Families covered at survey depth (one-line gist + miss-mode tag)

6. Hierarchical / summary trees — RAPTOR, MemTree.
7. Entity/claim canonicalization — SPIRES, KGGen, Triplex.
8. Query expansion and rewriting — HyDE, Query2Doc, step-back prompting.
9. Agentic iterative retrieval — Self-RAG, CRAG, Adaptive-RAG, FLARE.

### Families explicitly skipped

10. Predictive / world-model memory. Phase 1 closed this line; see `predictive_memory_phase1.md`.

### Prior-art as a first-class source

The ~20 phase memory entries in this repo and Silentium are mined alongside external papers. Some atlas entries will be "idea tried in this repo and killed — here is why"; these are as valuable as external papers and prevent rediscovery.

## Success criteria

The research is done *enough to act on* when:

- **Atlas coverage.** Every deep-family paper produces at least one entry; every surveyed family has at least a stub. Floor: ~25 entries. Ceiling open.
- **Miss-mode coverage.** Every miss-mode in the taxonomy (paraphrase, temporal, aggregation, context, schema, lexical, decomposition, granularity, analogy, sparse-precedent, compositional, scale) has at least one atlas entry that claims to kill it. Uncovered miss-modes are flagged as research gaps.
- **Combinations viability.** At least 5 compounds worth considering; at least 3 nullifications or mechanical conflicts identified. Fewer than 3 nullifications implies insufficiently skeptical reading.
- **Recipes actionability.** Each of the three recipes has (a) a named backbone, (b) at most 2 haiku insertion points, (c) an explicit "relation to what's already in the repo" paragraph with concrete pointers, (d) 2–3 open questions that only experiment can answer.
- **Prior-art coverage.** Every atlas entry that touches work already tried in this repo or Silentium references the relevant memory file or commit. No rediscovery.
- **Honest ceilings.** Each recipe names at least one miss-mode it still cannot kill. Zero stated ceilings means the research is lying.

## Non-goals

- Benchmark numbers on LOCOMO / MSC / internal tier-1/2/3 evals.
- Prototype code, sweeps, or tuning.
- Picking a single "winner" recipe.
- Commitments to which primitives become framework-level APIs.

All of the above are produced by the implementation plan that this spec feeds into, not by this spec.

## Relation to existing systems

This spec does not itself modify any code path or default. It reframes ongoing phase work (path-memory 2.x, Phase 7.x LOCOMO/MSC, inbox redesign, KB decomposition) as instances of atlas entries, surfacing which primitives are implicit in current code and which are missing. Concrete mappings — e.g. whether path-memory 2.14's `sessionDecayTau=0.2` is the repo's instantiation of a specific temporal-decay atlas entry — appear inside the atlas entries themselves, not here.

## What comes after this spec

1. Approve the spec.
2. Brainstorming hands off to `writing-plans`, which produces an implementation plan covering: paper discovery pass, atlas drafting pass, combinations analysis pass, per-domain recipe drafting, and a final review pass.
3. The implementation plan is executed in a separate session.
4. The three documents, once produced, feed the *next* round of brainstorming, which will pick a specific recipe to prototype and measure.
