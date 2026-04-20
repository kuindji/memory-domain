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

#### Atomic-fact extraction (subject-predicate-object form)

- **Gist:** Break every incoming message into the smallest standalone facts before storing anything.
- **Insight:** A raw chat turn mixes several claims, hedges, and conversational filler. If you store the whole turn, retrieval later has to wade through unrelated sentences to find the one fact that matters, and the embedding of the turn is an average of everything it says — which dilutes any one claim. Running an LLM pass that rewrites the turn as a list of short "X did Y" / "X is Y" sentences gives each fact its own row, its own embedding, and its own lifecycle. Later retrieval then matches the fact directly instead of matching a paragraph that happens to contain it.
- **Miss-mode killed:** paraphrase, decomposition, granularity
- **Where it lives:** ingest
- **Token cost:** many (one LLM call per incoming message at ingest)
- **Pairs with:** Context-preserving decomposition, Contradiction-based supersession, Similarity-batched dedup
- **Conflicts with:** none known
- **Paper(s):** Mem0 (2024), arxiv 2504.19413; A-Mem (2024), arxiv 2502.12110
- **Prior-art note:** prior-art index §B — project_inbox_redesign, kb_decomposition_next_steps; commits 4c255fc (code-repo atomic fact decomposition), 115c5bd (user inbox atomic claim extraction), 3309841 (KB atomic decomposition).

#### Contradiction-based supersession

- **Gist:** When a new fact contradicts an older stored fact about the same subject, mark the older one invalid instead of keeping both.
- **Insight:** Two opposing facts in memory force retrieval to guess which one the user currently believes. Mem0 and Zep both attack this by, at ingest time, pulling the top-K nearest existing facts about the same subject and asking an LLM "does the new claim replace, conflict with, or coexist with these?" If the LLM says replace or conflict, the older fact is flagged invalid (Mem0 deletes or overwrites; Zep closes a valid-time interval). The invariant: at most one active fact per (subject, attribute) at a time. This mirrors how a human updates a mental note — you cross out the old number when someone gives you a new one, you don't keep both and hope.
- **Miss-mode killed:** temporal, paraphrase, aggregation
- **Where it lives:** ingest
- **Token cost:** 1-per-item (LLM adjudication call against nearest neighbors)
- **Pairs with:** Atomic-fact extraction, Valid-time intervals, Similarity-batched dedup
- **Conflicts with:** Reflection/summary-over-facts (both compete for the "roll up redundancy" slot; coordinate them)
- **Paper(s):** Mem0 (2024), arxiv 2504.19413; Zep/Graphiti (2024), arxiv 2501.13956
- **Prior-art note:** prior-art index §B and §D — project_inbox_redesign, similarity_batching, and the chat temporal-validity spec; commits 4c255fc, 115c5bd, 9d9c6ce (contradiction detection on consolidation), a6f789f (LLM dedup merge), cbf9ea7 (validFrom/invalidAt on ChatAttributes).

#### Valid-time intervals (bi-temporal facts)

- **Gist:** Each fact records both when it was told to the system and the real-world time window it was true for.
- **Insight:** "Alice works at Acme" was true in 2022 but became false in 2024. If memory only knows "I learned this on date D," it cannot answer "where did Alice work in 2023?" Zep/Graphiti stores two timestamps per fact: when the system observed it and a real-world valid-from / valid-to window. When a newer fact supersedes an older one, the old fact isn't deleted — its valid-to is set to the moment of supersession. Queries can then ask "what was true as of 2023?" and get the right answer, and audits can replay what the system believed at any past moment. It is a database bi-temporal pattern transplanted into agent memory.
- **Miss-mode killed:** temporal
- **Where it lives:** ingest
- **Token cost:** none at storage time; the LLM extraction call (from atomic-fact extraction) already produces the times
- **Pairs with:** Contradiction-based supersession, Atomic-fact extraction
- **Conflicts with:** none known
- **Paper(s):** Zep/Graphiti (2024), arxiv 2501.13956
- **Prior-art note:** prior-art index §D — chat-temporal-validity-and-semantic-dedup spec; commits cbf9ea7, 9a6350a, d600b32, 9274ac3. Also path_memory_phase214 (session decay τ) in §A for the decay-based variant.

#### Context-preserving decomposition (fact + situational frame)

- **Gist:** Keep each atomic fact linked to the conversation or document it came from so its meaning survives extraction.
- **Insight:** A bare fact "the deadline is Friday" is useless without knowing which project and which Friday. Pure atomic extraction throws that context away. A-Mem's "notes" and Mem0's parent-linked memories attach to each atomic claim a small packet of situational scaffolding: source turn, surrounding topic, participants, and when relevant, related notes already in memory that the new one reacts to. At retrieval time the fact brings its frame along, so the LLM answering downstream can tell "Friday" means the project sprint Friday, not a generic one. The principle: decompose for matching, but never strand a fact from the frame that makes it meaningful.
- **Miss-mode killed:** context, decomposition, analogy
- **Where it lives:** ingest
- **Token cost:** 1-per-item (the same extraction LLM pass emits the frame link)
- **Pairs with:** Atomic-fact extraction, Reflection/summary-over-facts
- **Conflicts with:** none known
- **Paper(s):** A-Mem (2024), arxiv 2502.12110; Mem0 (2024), arxiv 2504.19413
- **Prior-art note:** prior-art index §C — kb_decomposition_next_steps ("keep parent, context-preserving facts"); commits 3309841 (KB atomic decomposition with parent), a55f2a5 (assert-claim sentinel parent for inbox discovery).

#### Hierarchical memory with paging (OS-style main context vs. archival)

- **Gist:** Treat the LLM's context window like RAM and a larger memory store like disk, with an explicit policy that pages facts in and out.
- **Insight:** Every LLM has a finite context. If you stuff the whole history in, quality drops and cost rises; if you summarize too aggressively, detail is lost. MemGPT reframes this as an operating-system problem: the model's context is working memory (small, fast, always visible), and an external store is archival memory (large, searched on demand). A small set of "syscalls" — read from archival, write to archival, evict from context — lets the model itself decide what to page in when a query arrives and what to page out when context gets full. Crucially the decision logic lives inside the model's tool-use loop, not in an outside heuristic, so it adapts per conversation.
- **Miss-mode killed:** scale, context, sparse-precedent
- **Where it lives:** query (paging is triggered by model tool-calls during inference)
- **Token cost:** many (each paging decision is an LLM tool-call)
- **Pairs with:** Reflection/summary-over-facts, Atomic-fact extraction
- **Conflicts with:** none known
- **Paper(s):** Letta/MemGPT (2023), arxiv 2310.08560
- **Prior-art note:** none (the memory-domain framework has no equivalent LLM-driven paging loop; the closest primitive is KB buildContext's budget-filling MMR in commit 77e6484, but that is heuristic, not agent-driven).

#### Reflection and summary-over-facts (periodic rollup)

- **Gist:** Periodically run an LLM pass that reads a batch of atomic facts and writes higher-level gists back into memory.
- **Insight:** Raw atomic facts multiply fast — dozens per conversation. Answering "what kind of person is Alice?" from forty individual claims is expensive and noisy. MemoryBank (inspired by human consolidation during sleep) and A-Mem both run a background reflection pass: cluster recent atomic facts, ask the LLM to write a short abstractive summary ("Alice prefers async work, dislikes morning meetings, lives in Berlin"), store the summary as its own memory with pointers to the source atoms. Retrieval can then hit the summary first for "persona" questions and drill down to atoms only when a specific detail is needed. It trades one-time LLM cost at idle for cheaper, sharper retrieval at query time.
- **Miss-mode killed:** aggregation, scale, sparse-precedent
- **Where it lives:** background
- **Token cost:** many (batched LLM call per cluster, amortized across queries)
- **Pairs with:** Atomic-fact extraction, Context-preserving decomposition, Hierarchical memory with paging
- **Conflicts with:** Contradiction-based supersession (if rollup and supersession both rewrite the same atoms, ordering matters — run supersession first so summaries don't immortalize invalidated claims)
- **Paper(s):** MemoryBank (2023), arxiv 2305.10250; A-Mem (2024), arxiv 2502.12110
- **Prior-art note:** prior-art index §D — chat consolidation path; commit a6f789f (chat deduplicates semantic memories during consolidation via LLM merge). Also §B similarity_batching, which is the batching primitive a reflection pass would reuse.

#### Forgetting curve (access-reinforced decay)

- **Gist:** Each memory's strength decays over time but is boosted every time it is accessed, so frequently-used facts persist and unused ones fade.
- **Insight:** MemoryBank borrows the Ebbinghaus forgetting curve: a memory's retrievability drops exponentially with age, but every successful retrieval resets the clock and raises a "strength" parameter so the next decay is slower. Over time this sorts memory into a working set of genuinely-useful facts and a long tail that quietly drops out of top-K retrieval without ever being explicitly deleted. Unlike hard TTL, it is self-tuning per item: a fact used ten times survives months of silence, a fact used once fades in days. This is the memory-side analogue of edge-hotness on the graph side.
- **Miss-mode killed:** scale, temporal
- **Where it lives:** background (decay accounting) plus query (access bumps strength)
- **Token cost:** none
- **Pairs with:** Reflection/summary-over-facts, Valid-time intervals
- **Conflicts with:** Valid-time intervals when both drive the same "should this fact surface?" decision — pick one as primary, use the other as a tiebreaker
- **Paper(s):** MemoryBank (2023), arxiv 2305.10250
- **Prior-art note:** prior-art index §A — path_memory_phase29 (edge-hotness from repeat access), path_memory_phase214 (sessionDecayTau=0.2 as default), path_memory_phase4a (edge-hotness soft-gate refuted on eval-C). The mechanism is partially validated for edges, refuted as a soft-gate on traversal.

### 2. Structured graph / hypergraph retrieval

GraphRAG, HippoRAG, HippoRAG 2, and LightRAG all share a common move: at ingest, an LLM converts raw text into an entity-and-relation graph; at query time, the graph serves as the retrieval index instead of (or alongside) a flat vector store. The mechanisms below unbundle that family.

#### LLM-extracted entity-relation graph at ingest

- **Gist:** Have an LLM read each document chunk and emit (subject, relation, object) triples, which become the nodes and edges of a retrieval graph.
- **Insight:** Raw embeddings smear related facts into a cloud; forcing an LLM to name entities and state relations produces discrete, reusable units that can be hit by name later. The graph acts as a structured summary that survives chunk boundaries — two passages that both mention "Alexander" both point at the same node.
- **Miss-mode killed:** paraphrase, lexical, decomposition
- **Where it lives:** ingest
- **Token cost:** many (one LLM extraction call per chunk at ingest)
- **Pairs with:** Entity-anchored retrieval, Personalized PageRank, Dual-index hypergraph retrieval
- **Conflicts with:** none known
- **Paper(s):** GraphRAG (2024), arxiv 2404.16130; HippoRAG (2024), arxiv 2405.14831; LightRAG (2024), arxiv 2410.05779
- **Prior-art note:** prior-art index §B — project_inbox_redesign, commits 4c255fc / 115c5bd already do LLM-based atomic-claim extraction; no dedicated edge-extraction pass between claims. §F — commit 2762003 indexes relation edge in/out fields, so edge-centric indexing primitive exists.

#### Synonym edges between near-duplicate entity nodes

- **Gist:** After extraction, connect two entity nodes with a "synonym" edge whenever their name embeddings are close enough (e.g. cosine ≥ 0.8).
- **Insight:** LLM extraction produces surface-form variants ("Alexander the Great", "Alexander III of Macedon", "Alexander"). Without bridging edges the graph fragments into disconnected islands and traversal dies. A cheap embedding-threshold pass stitches the islands so later graph walks can cross surface forms for free, without asking the LLM to canonicalize.
- **Miss-mode killed:** paraphrase, lexical
- **Where it lives:** ingest (post-extraction)
- **Token cost:** none (embedding-only, no LLM)
- **Pairs with:** Entity-anchored retrieval, Personalized PageRank
- **Conflicts with:** none known
- **Paper(s):** HippoRAG (2024), arxiv 2405.14831
- **Prior-art note:** prior-art index §F — commit 106b0a3 adds dedup aliases; similar spirit but at the record level, not between graph nodes.

#### Entity-anchored retrieval (seed-node lookup)

- **Gist:** At query time, extract named entities from the question and look them up in the graph to find the passages they anchor.
- **Insight:** Vector search asks "which chunk looks like the question?"; entity anchoring asks "which chunks mention what the question is about?" When the question names specific things, the second framing is far more precise — it skips the paraphrase tax and produces a small set of pin-pointed entry nodes that later stages can expand from.
- **Miss-mode killed:** paraphrase, lexical, decomposition
- **Where it lives:** query
- **Token cost:** 1-per-query (LLM extracts query entities)
- **Pairs with:** Synonym edges, Personalized PageRank, Community summaries
- **Conflicts with:** none known
- **Paper(s):** HippoRAG (2024), arxiv 2405.14831; LightRAG (2024), arxiv 2410.05779
- **Prior-art note:** prior-art index §A — path_memory_phase28 default runner already does anchor-node entry + weighted fusion across hops; §C — commits aecc0e4, bfe91d0 do intent-filtered KB entry but not entity-graph anchoring.

#### Personalized PageRank over the memory graph

- **Gist:** Treat the query's matched entity nodes as "home" and let a random walker wander the graph biased toward returning home; the passages attached to the most-visited nodes are the answer set.
- **Insight:** PPR solves the multi-hop problem without the caller having to plan a path. A node gets a high score either because it is a seed or because it sits on many short routes from seeds — which is exactly what "related to the question in several ways" means. Compared to breadth-first traversal, PPR naturally weighs by graph density and damps distant noise without a hard hop limit.
- **Miss-mode killed:** compositional, decomposition, sparse-precedent
- **Where it lives:** query
- **Token cost:** none at the walk itself (1-per-query upstream for seed extraction)
- **Pairs with:** Entity-anchored retrieval, Synonym edges, Recognition-memory triple filter
- **Conflicts with:** Spreading-activation with tier inhibition on small graphs (dilutes signal)
- **Paper(s):** HippoRAG (2024), arxiv 2405.14831
- **Prior-art note:** prior-art index §A — path_memory_phase210 refuted SYNAPSE (activation spreading with tier-2 inhibition) on this repo's small graphs (eval-A regresses, eval-B flat); ships opt-in only. PPR is the non-inhibited cousin; the refutation is specific to tier-inhibition + small-graph dilution, so PPR proper is still open. path_memory_phase4a also refuted per-edge hotness soft-gating on eval-C.

#### Passage nodes inside the entity graph (bridge nodes)

- **Gist:** Add each original passage as its own node in the graph, linked by "contains" edges to every entity extracted from it, so the walk can land directly on passages.
- **Insight:** An entity-only graph forces a second lookup step ("which passages mention this node?") that loses ranking information. Putting passages into the graph lets the same walk score entities and passages jointly — a passage that sits between two queried entities lights up even if neither entity alone would have ranked it.
- **Miss-mode killed:** context, granularity
- **Where it lives:** ingest (add nodes) + query (seed with passage embedding similarity)
- **Token cost:** none beyond the base extraction
- **Pairs with:** Personalized PageRank, Recognition-memory triple filter
- **Conflicts with:** entity-pure graphs (this is the explicit fix for them)
- **Paper(s):** HippoRAG 2 (2025), arxiv 2502.14802
- **Prior-art note:** prior-art index §A — no phase so far has experimented with passage-as-graph-node; this is a clean candidate for the post-Phase-7 slot.

#### Recognition-memory triple filter (LLM rerank of retrieved triples)

- **Gist:** Before the graph walk, retrieve top-k triples by embedding and have a short LLM call throw out the ones that don't actually match the question.
- **Insight:** Seed quality dominates PPR output — one bad seed poisons the whole walk. A cheap LLM pass over a few dozen triples acts like a recognition gate ("is this really what the question is asking about?") and costs far less than scaling up the retriever. It is the "system 2" check that embedding similarity can't do.
- **Miss-mode killed:** context, lexical (false-friend embeddings)
- **Where it lives:** query
- **Token cost:** 1-per-query (one small LLM call per query)
- **Pairs with:** Personalized PageRank, Entity-anchored retrieval
- **Conflicts with:** none known
- **Paper(s):** HippoRAG 2 (2025), arxiv 2502.14802
- **Prior-art note:** prior-art index §C — commit 607d943 does LLM-based re-ranking of KB buildContext results (passage-level, not triple-level); be4d677 makes it toggleable. Triple-level version is not yet implemented.

#### Hierarchical community detection + pre-generated community summaries

- **Gist:** Run a clustering algorithm (Leiden) over the entity graph to produce nested "communities," then have an LLM write a summary for each community at ingest time.
- **Insight:** Small questions hit entities; big questions ("what are the main themes?") hit groups of entities. Precomputing group-level summaries lets those sense-making queries answer from short, already-aggregated text instead of trying to stitch thousands of chunks at query time. The hierarchy means you can pick the right zoom level per query.
- **Miss-mode killed:** aggregation, scale
- **Where it lives:** ingest (clustering + summary generation) + background (re-cluster on growth)
- **Token cost:** many at ingest (one LLM call per community per level); 1-per-query at serve time
- **Pairs with:** Map-reduce global query, LLM-extracted entity-relation graph
- **Conflicts with:** Atomic-fact extraction (summaries are lossy by design — two memories of truth)
- **Paper(s):** GraphRAG (2024), arxiv 2404.16130
- **Prior-art note:** prior-art index §F — commit e2b816a adds topic-linking plugin with shared cross-domain logic; topics are the closest primitive but not hierarchical communities. No prior phase has built Leiden-style clustering.

#### Map-reduce global query over community summaries

- **Gist:** For a broad question, generate a partial answer from every community summary in parallel, then merge the partials into one final answer.
- **Insight:** A single LLM call can't hold thousands of chunks, and top-k retrieval silently drops most of the corpus for questions that need all of it ("what are the recurring themes?"). Fanning out over pre-summarized communities turns a corpus-scale read into many small reads whose answers compose — trading serial context pressure for parallel LLM calls.
- **Miss-mode killed:** aggregation, scale
- **Where it lives:** query
- **Token cost:** many (one LLM call per community hit + final reduce)
- **Pairs with:** Community summaries (required), LLM-extracted entity-relation graph
- **Conflicts with:** latency budgets; point-lookup queries (wasteful fan-out)
- **Paper(s):** GraphRAG (2024), arxiv 2404.16130
- **Prior-art note:** none — no repo phase has attempted map-reduce over corpus partitions.

#### Dual-index retrieval: specific-entity keys vs theme-level keys

- **Gist:** Build two parallel indexes at ingest — one keyed by specific entity names (low-level), one keyed by the overarching themes an entity/relation participates in (high-level) — and route each query against both.
- **Insight:** "Who diagnoses heart disease?" wants a specific entity; "how does cardiology relate to lifestyle?" wants themes. A single embedding index blurs the two. Splitting the index by keyword granularity lets precise questions stay precise while conceptual questions retrieve the right abstraction layer, without a router needing to guess which one the query is.
- **Miss-mode killed:** granularity, aggregation, analogy
- **Where it lives:** ingest (two indexes) + query (dual lookup + merge via one-hop neighbor expansion)
- **Token cost:** many at ingest (LLM writes theme keys per edge); 1-per-query (LLM extracts low vs high keywords from query)
- **Pairs with:** LLM-extracted entity-relation graph, Entity-anchored retrieval
- **Conflicts with:** none known
- **Paper(s):** LightRAG (2024), arxiv 2410.05779
- **Prior-art note:** prior-art index §A — path_memory_phase216 tested same-family RRF across {BGE-base, BGE-large} (partial: tier-2 eval-A +0.053 but coherence 3/4→2/4). That was two encoders over one granularity; LightRAG's dual-index is one encoder over two granularities — orthogonal, unexplored here. §C — commit e4061c6 adds dual-path search for recall, conceptually adjacent.

#### Incremental graph update on new ingest

- **Gist:** When a new document arrives, extract its triples and merge them into the existing graph (add new nodes/edges, reconnect via synonym threshold) instead of rebuilding the index.
- **Insight:** Graph-RAG systems accrete cost fast if every new chunk triggers re-clustering and re-summarization. Making the graph merge-friendly — nodes keyed by canonical name, synonym edges recomputed only for new nodes against nearest neighbors — keeps ingest O(new chunks) instead of O(corpus). Community summaries can be lazily invalidated rather than eagerly rebuilt.
- **Miss-mode killed:** scale (operational, not retrieval)
- **Where it lives:** ingest
- **Token cost:** scales with new content only
- **Pairs with:** LLM-extracted entity-relation graph, Synonym edges, Community summaries (with lazy invalidation)
- **Conflicts with:** eager hierarchical re-clustering
- **Paper(s):** LightRAG (2024), arxiv 2410.05779
- **Prior-art note:** prior-art index §F — commit 2249076 (perf: cut WDI ingestion ~47% via topic-linking tiers) is the nearest repo-side primitive; cb9ccbe adds topic-linking vector-only mode for dedup. Incremental graph merge on a per-triple basis not yet built.

### 3. Query decomposition and planning

#### Sub-question fanout (Self-Ask)

- **Gist:** The model writes its own follow-up questions, answers each (optionally with a search call), and composes the final answer.
- **Insight:** Large models often know every sub-fact of a multi-hop question yet still miss the composed answer — a "compositionality gap." Forcing the model to name and resolve each follow-up in turn closes part of that gap, and the named follow-ups are clean handles for an external lookup.
- **Miss-mode killed:** compositional, aggregation (where every atom is retrievable but the joined answer is not)
- **Where it lives:** query
- **Token cost:** many (one generation plus one retrieval per follow-up)
- **Pairs with:** Atomic-fact extraction (atomic stores supply clean targets for follow-ups); Reciprocal-rank fusion across follow-ups
- **Conflicts with:** single-shot top-k retrieval with hard intent filters — a filter tuned for the outer question will starve follow-ups that ask something adjacent.
- **Paper(s):** Measuring and Narrowing the Compositionality Gap in Language Models (2023); arxiv 2210.03350
- **Prior-art note:** prior-art index §C. kb_architecture_testing built per-intent candidate filtering and classified at 43%; bfe91d0 wired intent-driven filtered search; 106b0a3 removed those filters as a negative result. The takeaway is that a single outer-question intent is too coarse — Self-Ask-style follow-ups would each carry their own intent, which is the level at which filtering was failing. kb_decomposition_next_steps (keep parent + context-preserving facts) is the ingest-side pair to this query-side decomposition.

#### Interleaved retrieve-and-reason (IRCoT)

- **Gist:** Alternate one step of chain-of-thought with one retrieval, letting each retrieval be conditioned on everything reasoned so far.
- **Insight:** In multi-hop questions, what to look up next only becomes visible after the previous hop is resolved. A one-shot retrieve-then-read misses later hops because their keywords are not in the original question. Treating retrieval as a loop — generate a reasoning sentence, retrieve on it, append, repeat — lets each hop's keywords surface naturally and cuts hallucinated intermediate facts.
- **Miss-mode killed:** compositional (second-hop-invisible queries), context
- **Where it lives:** query
- **Token cost:** many (k reasoning + k retrievals, k ≈ 2–5)
- **Pairs with:** Sub-question fanout (IRCoT is the implicit version of Self-Ask); path-memory graph walks, since the "next hop" is naturally a neighbor lookup
- **Conflicts with:** latency-bounded retrieval; precision-first pipelines that assume one narrow candidate pool
- **Paper(s):** Interleaving Retrieval with Chain-of-Thought Reasoning for Knowledge-Intensive Multi-Step Questions (2023); arxiv 2212.10509
- **Prior-art note:** prior-art index §A. path_memory_phase210 (SYNAPSE spreading activation) is the non-LLM analogue — both try to let later hops be driven by earlier ones. SYNAPSE was refuted on eval-A and flat on eval-B because a graph walk without a reasoning signal dilutes on small graphs; IRCoT's reasoning signal is exactly what that walk was missing. path_memory_phase4a edge-hotness gate similarly refuted — suggests structural hop-selection is not enough on this corpus; the reasoning-driven variant is the open slot.

#### Abstract-then-retrieve (Step-Back)

- **Gist:** Before answering, rewrite the question at a higher level of abstraction and retrieve on that abstracted form first.
- **Insight:** Specific questions often contain surface detail (a date, a proper noun, a unit) that crowds out the general concept needed for retrieval. Asking the model to first state the principle or category behind the question — "what is the policy governing X" before "was X allowed on date Y" — produces a query that matches the background facts in the store, and the specific details are then re-applied during answer composition. Reported gains of 7–27% on reasoning-heavy benchmarks.
- **Miss-mode killed:** paraphrase (over-specific queries where the embedding is dominated by detail tokens), analogy
- **Where it lives:** query
- **Token cost:** 1-per-query (one extra generation for the abstraction)
- **Pairs with:** HyDE-style query expansion; Reciprocal-rank fusion across (specific, abstract) views
- **Conflicts with:** corpora where precision depends on the specific entity (a pure lookup store) — abstraction will wash out the anchor
- **Paper(s):** Take a Step Back: Evoking Reasoning via Abstraction in Large Language Models (2024); arxiv 2310.06117
- **Prior-art note:** prior-art index §A. path_memory_phase216 same-family RRF across BGE-base/large did lift tier-2 eval-A but regressed coherence — a view-fusion signal that different query formulations retrieve complementary neighbourhoods. Step-back generates a semantically distinct view rather than an encoder-distinct one; it is the under-tested axis of that fusion result. §C. kb_architecture_testing intent classification (43%) probably suffered partly from surface specificity — abstraction would move the classifier to a coarser, easier decision.

#### Planner-led retrieval over a plan graph (PlanRAG, Plan*RAG)

- **Gist:** Generate an explicit plan — a sequence or DAG of atomic sub-queries — once, then execute retrieval against the plan rather than letting the model improvise.
- **Insight:** Reactive loops (IRCoT, Self-Ask) keep the plan inside the model's working context and fragment it under long chains. Lifting the plan out as a separate object — a written list of steps or a DAG where each node is one atomic sub-query and edges are data dependencies — lets independent nodes retrieve in parallel, keeps each node's context small, and makes the plan auditable and re-executable. PlanRAG re-plans when a step fails; Plan*RAG commits to the DAG at test time and parallelises leaves.
- **Miss-mode killed:** compositional (plan drift in long chains), scale (context-window blow-up on multi-hop)
- **Where it lives:** query
- **Token cost:** many (one plan generation + one retrieval per node; parallelisable)
- **Pairs with:** Sub-question fanout (each DAG leaf is a follow-up); Atomic-fact extraction (DAG leaves match the ingest granularity); rerank stages at the join
- **Conflicts with:** short single-hop queries where planning overhead dominates; corpora where the schema needed to plan is not exposed
- **Paper(s):** PlanRAG: A Plan-then-Retrieval Augmented Generation for Generative LLMs as Decision Makers (NAACL 2024); arxiv 2406.12430. Plan*RAG: Efficient Test-Time Planning for Retrieval Augmented Generation (2024); arxiv 2410.20753
- **Prior-art note:** prior-art index §A. path_memory_phase211_deferred (MAGMA per-view router) is this family's closest internal attempt — a router picks a retrieval view per query. It was deferred after a dry-run null (1 unique tuple across 38 tier-2 probes), diagnosed as too-coarse view granularity rather than the idea being wrong; the PlanRAG/Plan*RAG framing suggests the right unit is a sub-query node, not a whole-query view. §C. kb_decomposition_next_steps (keep parent + context-preserving facts) is the ingest counterpart that would give such a plan concrete leaves to hit.

### 4. Re-ranking and late-interaction

#### Token-level late interaction (ColBERT-style MaxSim)

- **Gist:** Keep one vector per token for both query and candidate, score a pair by summing each query-token's best match against candidate tokens.
- **Insight:** Pooling a passage into a single vector blurs out rare but decisive words. Keeping all token vectors and asking "for each query word, what's the most similar word in this candidate" recovers fine-grained matches that a single dot product throws away. The sum of these per-token maxes is the relevance score.
- **Miss-mode killed:** lexical (rare-term washout in mean-pooled embeddings), paraphrase (semantic near-miss where the decisive word is one clause inside a long passage)
- **Where it lives:** query (scoring) with ingest-time token-vector storage
- **Token cost:** none (no LLM calls — it's a vector operation, just many more vectors per item)
- **Pairs with:** residual/centroid compression to keep storage tractable; cheap first-stage retriever that shortlists before MaxSim runs
- **Conflicts with:** storage-constrained deployments without compression; single-vector HNSW indexes (requires a different index shape)
- **Paper(s):** ColBERTv2: Effective and Efficient Retrieval via Lightweight Late Interaction (2022); arxiv 2112.01488
- **Prior-art note:** Not implemented in-repo. Current retrievers (phase 2.13/2.15) use pooled single-vector encoders (BGE-base, BGE-large). Phase 2.15 refuted BGE-large retune as a coherence fix and flagged "encoder-granularity-bound" ceilings on arcs like Alexander-succession — the miss-mode late-interaction targets directly.

#### Cross-encoder pointwise rerank

- **Gist:** A model reads the query and one candidate together and emits a single relevance number; you repeat per candidate and re-sort.
- **Insight:** First-stage retrieval picks candidates fast by comparing pre-computed vectors. A cross-encoder is slow but accurate because it lets query and candidate attend to each other token by token. You only pay the cost on the shortlist, not the full corpus.
- **Miss-mode killed:** lexical (BM25 lexical-but-irrelevant hits), paraphrase (near-duplicate embedding hits where the actual answer is a sibling passage)
- **Where it lives:** query (post-retrieval rerank stage)
- **Token cost:** 1-per-item (one model forward pass per candidate; no generation)
- **Pairs with:** cheap first-stage retriever (embedding or BM25) that produces the shortlist; cascade rerank where this is the mid-tier
- **Conflicts with:** very large candidate pools without aggressive pruning (latency explodes linearly)
- **Paper(s):** BGE-Reranker-v2-m3 model card (2024); Cohere Rerank 3 (2024). Survey-level prior art in passage reranking with BERT (Nogueira & Cho, 2019; arxiv 1901.04085)
- **Prior-art note:** prior-art index §C. Repo has an embedding-based reranker (commit af6c810) and wires it into KB buildContext (commit 91874db), with a toggle (commit be4d677). No true cross-encoder is wired — the current "embedding rerank" still pools both sides into vectors. Phase 7.6 candidates (path_memory_phase76_candidates) flag precision as the active failure mode, which is exactly what a pointwise cross-encoder targets.

#### Listwise LLM rerank (RankGPT-style)

- **Gist:** Hand an LLM the query plus N candidates in one prompt and ask it to return them in ranked order.
- **Insight:** A pointwise reranker scores each candidate in isolation, so it can't tell that candidate #3 actually subsumes #7. Giving the LLM the whole list lets it compare candidates to each other, which matches how humans judge relevance. Because LLMs can't fit the full shortlist in one window, you slide a window over the list, re-ranking chunks and bubbling winners forward.
- **Miss-mode killed:** aggregation (redundant top-k where several near-duplicates crowd out diverse evidence); ordering errors between close candidates that pointwise scoring can't distinguish
- **Where it lives:** query (final rerank stage)
- **Token cost:** many (the whole candidate window sits in the prompt, plus instructions; often several windows per query)
- **Pairs with:** cross-encoder or embedding rerank as a prefilter to shrink N; cascade rerank where this is the top tier
- **Conflicts with:** latency-sensitive paths; positional-bias-sensitive setups (LLMs privilege early/late items in the list — see 2411.04602 self-calibrated listwise for a mitigation)
- **Paper(s):** Is ChatGPT Good at Search? Investigating LLMs as Re-Ranking Agents (2023); arxiv 2304.09542. Self-Calibrated Listwise Reranking (2024); arxiv 2411.04602. FIRST: Faster Improved Listwise Reranking with Single Token Decoding (2024); arxiv 2406.15657
- **Prior-art note:** prior-art index §C. Repo had an LLM-based rerank on KB buildContext (commit 607d943), made toggleable (commit be4d677), and later the LLM call was dropped in favor of lighter paths (commit 106b0a3). Current default stance (`feedback_exhaust_non_llm_first`) parks listwise LLM rerank until rule-based and geometric options are exhausted; the mechanism remains available behind a toggle.

#### Reciprocal-rank fusion (RRF) across retrievers

- **Gist:** Merge multiple ranked lists by summing 1/(k+rank) for each item across lists, then sort by that sum.
- **Insight:** Different retrievers (BM25, embedding-A, embedding-B, graph walk) disagree on scores, and their score scales aren't comparable. But rank positions are. Items that show up near the top of several lists win; items top-ranked in only one list lose to consensus picks. The constant k (typically 60) dampens the first few positions so the #1 from one retriever can't single-handedly dominate.
- **Miss-mode killed:** lexical (single-retriever blind spots — BM25 misses paraphrase, embeddings miss rare terms); score-scale incompatibility when combining heterogeneous scorers
- **Where it lives:** query (fusion stage between retrieval and rerank)
- **Token cost:** none (pure rank arithmetic)
- **Pairs with:** heterogeneous retrievers (BM25 + dense + graph); as a cheap first stage before cross-encoder rerank in a cascade
- **Conflicts with:** cases where one retriever is strictly better — fusion drags its quality down; coherence-sensitive arcs where consensus across similar encoders adds noise rather than signal
- **Paper(s):** Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods (Cormack, Clarke, Büttcher, SIGIR 2009)
- **Prior-art note:** prior-art index §A. Repo ships same-family RRF ({BGE-base, BGE-large}) opt-in (path_memory_phase216, commit 2f9b63c). Outcome P/mixed: tier-2 eval-A +0.053 and tier-1 eval-A +0.056, but tier-2 coherence regressed 3/4 → 2/4. The k constant was inert in that sweep. Stage B/C/D (cross-family RRF with BM25 / graph) is still open. Phase 2.8 weighted-fusion τ=0.2 is a related but score-space (not rank-space) fusion already shipping as default.

#### Cheap-then-expensive cascade rerank

- **Gist:** Run candidates through stages that get slower and more accurate, pruning aggressively between stages.
- **Insight:** The expensive scorer (LLM, cross-encoder) is too slow to run on thousands of candidates, and the cheap scorer (BM25, embedding) is too blurry to trust at k=5. A cascade uses each scorer at the candidate-pool size it can handle: 10000 → BM25/embedding → 200 → cross-encoder → 20 → listwise LLM → 5. Total latency is dominated by the shortlist size of the slow stage, not the corpus size.
- **Miss-mode killed:** the latency/accuracy tradeoff forcing a single-stage choice; false confidence from a cheap scorer at small k; LLM cost blow-up from scoring the full corpus
- **Where it lives:** query (pipeline structure across retrieval + rerank)
- **Token cost:** many (only at the top stage, on a small shortlist) + 1-per-item (middle stage) + none (bottom stage)
- **Pairs with:** RRF at the bottom to merge heterogeneous retrievers into the initial pool; cross-encoder in the middle; listwise LLM at the top; precision-tuning knobs (resultTopN, anchorTopK) to set between-stage pool sizes
- **Conflicts with:** pipelines where any stage has high recall-loss at its pool size (a bad middle stage starves the top stage); strict latency budgets that can't fit the slow stage at all
- **Paper(s):** Implicit in RankGPT's sliding window + first-stage retriever setup (arxiv 2304.09542); FIRST (arxiv 2406.15657) optimizes the top stage; general multi-stage ranking tradition (Wang et al., "A cascade ranking model for efficient ranked retrieval", SIGIR 2011)
- **Prior-art note:** prior-art index §A, §C. Repo has the primitives for a 3-stage cascade but they are not composed as one: embedding rerank (af6c810, 91874db), LLM rerank (607d943, currently parked), toggleability (be4d677), weighted-fusion τ (phase 2.8), same-family RRF (phase 2.16). Phase 7.6 candidates explicitly recommend tightening resultTopN + anchorTopK before touching retriever internals — that is cascade pool-size tuning under a different name. No explicit cascade controller wires the stages end-to-end today.

### 5. Temporal reasoning over memory

#### Bi-temporal edges (valid-time vs transaction-time)

- **Gist:** Every fact carries two separate timelines — when it was true in the world, and when the system learned it.
- **Insight:** Collapsing "when it happened" into "when we stored it" loses the ability to answer "what did we believe on date X" vs "what was actually true on date X". Bi-temporal storage keeps both, so audits, replays, and retroactive corrections all work without rewriting history.
- **Miss-mode killed:** temporal (stale-fact pollution where a correction overwrites the original instead of superseding it; inability to distinguish "we didn't know yet" from "it wasn't true yet")
- **Where it lives:** ingest (stamp transaction-time) + ingest (extract valid-time from the claim)
- **Token cost:** none (two timestamps per fact)
- **Pairs with:** Event-valid-interval gating; Supersession-by-valid-time
- **Conflicts with:** none known
- **Paper(s):** Zep: A Temporal Knowledge Graph Architecture for Agent Memory (2025); arxiv 2501.13956. Temporal KG representation survey (2024); arxiv 2403.04782
- **Prior-art note:** Implemented. Spec `docs/superpowers/specs/2026-04-12-chat-temporal-validity-and-semantic-dedup.md` defines `validFrom` / `invalidAt` on chat attributes; commit cbf9ea7 adds the fields and commit 9a6350a sets `validFrom` on promotion from episodic. Ingest-time is separately captured by existing memory row timestamps and by commit 8d587ac's `event_time` index.

#### Event-valid-interval gating at query time

- **Gist:** Drop any fact whose [validFrom, validUntil] window doesn't contain the query's "as-of" time.
- **Insight:** A fact like "Alice works at Acme" is only useful in answers about the period Alice actually worked there. The retriever attaches an interval to each candidate and filters by whether the query time falls inside it, so expired facts never surface as current evidence.
- **Miss-mode killed:** temporal (retriever returning a high-similarity but factually expired claim; answers that mix past and present states of the same entity)
- **Where it lives:** query
- **Token cost:** none (metadata check)
- **Pairs with:** Bi-temporal edges; Supersession-by-valid-time
- **Conflicts with:** queries that explicitly want historical state — gating must be disableable when the user asks "what did we know in 2024"
- **Paper(s):** Zep / Graphiti (2025); arxiv 2501.13956. Temporal KG QA survey (2024); arxiv 2406.14191
- **Prior-art note:** Implemented. Commit 9274ac3 filters invalidated memories from `buildContext`; commit d600b32 skips invalidated memories during decay pruning (so they stop competing at retrieval). The `event_time` index from commit 8d587ac is the substrate for range gating.

#### Supersession-by-valid-time (LLM contradiction resolution)

- **Gist:** When a new claim contradicts an older one, close the older one's validity interval at the new claim's valid-time — "newer" means newer in the world, not newer in the log.
- **Insight:** Two claims about the same subject that can't both be true get compared by an LLM; the loser's `validUntil` is set to the winner's `validFrom`. This preserves the loser as historical record while removing it from current answers. Crucially it sorts by when the fact was true, not when we heard about it — so a late-arriving 2023 claim correctly supersedes a 2024 claim that was ingested earlier.
- **Miss-mode killed:** temporal (race-condition where late ingest of an old truth overwrites a newer one; answers flipping to stale state because the stale record was inserted most recently)
- **Where it lives:** ingest (consolidation / inbox)
- **Token cost:** 1 LLM call per candidate conflict group
- **Pairs with:** Bi-temporal edges; Event-valid-interval gating; similarity batching (so the LLM sees the conflict set at once)
- **Conflicts with:** naive "latest-ingest wins" policies
- **Paper(s):** Zep / Graphiti (2025); arxiv 2501.13956. Mem0 (2025); arxiv 2504.19413 (uses UPDATE/DELETE ops without bi-temporal; weaker variant)
- **Prior-art note:** Implemented as mechanism, partial on valid-time sort key. Commit 9d9c6ce detects contradictions during consolidation via `extractStructured`; commit a6f789f LLM-merges semantic near-duplicates; inbox similarity-batching (`memory/similarity_batching.md`) gives the LLM the grouped rival claims. The repo today sets `invalidAt` on contradiction; routing the decision by `validFrom` rather than ingest order is the Graphiti-style upgrade still open.

#### Exponential decay of access score (half-life forgetting)

- **Gist:** A memory's retrieval weight drops smoothly with time since its last access; small τ means fast forgetting, large τ means near-permanent.
- **Insight:** Instead of a hard TTL, multiply each candidate's score by `exp(-age/τ)`. Interpret τ as "the age at which the weight falls to ~37%", or roughly half-life ≈ 0.69·τ. Tuning τ alone moves the system between "strong recency bias" and "effectively stateless recency". Combines cleanly with base similarity since both are multiplicative weights.
- **Miss-mode killed:** temporal (stale-but-frequent memories crowding out fresh relevant ones); scale (unbounded memory growth where nothing ever loses retrieval probability)
- **Where it lives:** query (apply at scoring) or background (bake into stored score)
- **Token cost:** none
- **Pairs with:** Ebbinghaus reinforcement on re-access; edge-hotness on graphs
- **Conflicts with:** strict ranked-recall evaluations where the gold set ignores time
- **Paper(s):** MemoryBank (2023); arxiv 2305.10250. Mem0 (2025); arxiv 2504.19413. Temporal KG survey (2024); arxiv 2403.04782
- **Prior-art note:** Implemented and tuned. path_memory_phase214 promoted `sessionDecayTau=0.2` (tier-2 eval-B coherence 2/4 → 3/4); phase 2.13 set session decay ON by default; phase 2.8 previously shipped it OFF before the encoder upgrade — so this repo has already traversed the tuning curve and has data showing τ is only effective once the encoder is strong enough for the bump to matter.

#### Ebbinghaus-style reinforcement on re-access

- **Gist:** Each retrieval of a memory pushes its decay clock back and/or increases its stored strength, so frequently-touched facts fade slower.
- **Insight:** Classical forgetting-curve psychology: strength `S = exp(-t/s)` where the stability parameter `s` grows each time the item is successfully recalled. In practice this is "reset last_access on read" plus a stability multiplier that makes each subsequent decay shallower. The result is a spaced-repetition-like dynamic where important-because-recalled memories self-curate, without anyone labeling importance.
- **Miss-mode killed:** temporal (useful memories decaying out because they weren't accessed in a while even though they were accessed often historically; losing long-tail but high-value items to flat time-based TTLs)
- **Where it lives:** query (on read: update last_access and stability) + background (periodic re-score)
- **Token cost:** none (counter + timestamp write)
- **Pairs with:** Exponential decay of access score; edge-hotness; importance scoring
- **Conflicts with:** strict privacy/forgetting requirements where access should not extend retention
- **Paper(s):** MemoryBank (2023); arxiv 2305.10250 (direct Ebbinghaus); Mem0 (2025); arxiv 2504.19413 (access-based update ops)
- **Prior-art note:** Partially implemented. path_memory_phase29 shows edge-weight hotness emerges naturally from repeat access with mean edgeRatio 7.72× on repeat-user arcs — effectively reinforcement on the graph side. Node-level reinforcement on memory rows (reset last_access + stability growth) is not yet in-tree; phase 4a refuted the edge-hotness soft-gate on eval-C, so node-level stability is the open slot rather than more edge-gating.

#### Temporal-graph retrieval (time-aligned subgraph selection)

- **Gist:** Build a graph where edges carry timestamps or intervals, then at query time restrict traversal to the time-aligned subgraph before retrieving nodes.
- **Insight:** Instead of filtering results after the fact, shape the candidate set up front: anchor the query to a time window, walk only edges whose validity intersects that window, and let standard graph retrieval do the rest. Multi-granularity time nodes (day / month / era) let a single query attach to whichever resolution matches the question. Cheaper and more precise than post-filtering a time-blind subgraph.
- **Miss-mode killed:** temporal (cross-era bleed where a shortest path stitches together facts from decades that never co-existed); paraphrase (similarity-based retrieval picking a time-indistinguishable embedding)
- **Where it lives:** ingest (stamp edges with time) + query (time-align before walk)
- **Token cost:** none
- **Pairs with:** Event-valid-interval gating; Bi-temporal edges; Dijkstra / path-memory traversal
- **Conflicts with:** time-agnostic questions where restricting the subgraph hurts recall
- **Paper(s):** TG-RAG "RAG Meets Temporal Graphs" (2025); arxiv 2510.13590. TimeRAG / STAR-RAG (2025). Temporal KG QA survey (2024); arxiv 2406.14191
- **Prior-art note:** Substrate present, time-alignment step not wired. Path-memory (phases 2.8 / 2.9 / 2.13) supplies the graph walk and weighted fusion; `event_time` index (commit 8d587ac) supplies the per-edge timestamp; `validFrom`/`invalidAt` (cbf9ea7) supplies the interval. The time-aligned-subgraph restriction at traversal time is the open atom. path_memory_phase211_deferred (MAGMA) flagged per-view routing as a candidate — a time-view router is a natural special case.

### 6. Survey-depth families

Stubs only (name + gist + miss-mode + citation + prior-art). Expand to full entries if a recipe in `domain-recipes.md` pulls them in.

#### Hierarchical / summary trees (RAPTOR)

- **Gist:** Build a tree of progressively-summarized nodes over a corpus at ingest, then let retrieval match against any level of the tree.
- **Miss-mode killed:** aggregation, scale
- **Where it lives:** ingest (cluster + summarize recursively)
- **Paper(s):** RAPTOR (2024), arxiv 2401.18059
- **Prior-art note:** none. Compare with §2 Community summaries (GraphRAG) — both are "summarize clusters" moves; RAPTOR is chunk-clustering, GraphRAG is entity-clustering.

#### Memory tree with agentic editing (MemTree)

- **Gist:** Maintain a tree of memories where an agent decides on each new input whether to insert, merge, split, or re-summarize.
- **Miss-mode killed:** aggregation, scale, temporal (via explicit edit ops)
- **Where it lives:** ingest (agent-driven edits)
- **Paper(s):** MemTree (2024)
- **Prior-art note:** none — closest in spirit is §1 Reflection rollup but agent-driven rather than batched.

#### Claim canonicalization via structured extraction (SPIRES / KGGen)

- **Gist:** Use schema-guided LLM extraction to coerce free-text claims into a typed, normalized form keyed off an ontology.
- **Miss-mode killed:** schema, lexical, paraphrase
- **Where it lives:** ingest
- **Paper(s):** SPIRES (Caufield et al. 2023); KGGen (2024)
- **Prior-art note:** §C commit aecc0e4 (query intent classification for KB) is a query-side cousin; no ingest-side schema coercion in-tree.

#### Fast triple extraction (Triplex)

- **Gist:** A small fine-tuned model does triple extraction at a fraction of the cost of a full-size LLM, with accuracy close enough for most graph-RAG uses.
- **Miss-mode killed:** schema, operational-scale
- **Where it lives:** ingest
- **Paper(s):** Triplex (SciPhi, 2024)
- **Prior-art note:** none. Directly relevant to token-budget of §2 LLM-extracted entity-relation graph.

#### HyDE (hypothetical-document embedding)

- **Gist:** At query time, ask the LLM to write a hypothetical answer, embed that hypothetical, and use its embedding to search.
- **Miss-mode killed:** paraphrase (question-shape vs. answer-shape mismatch)
- **Where it lives:** query
- **Token cost:** 1-per-query
- **Paper(s):** HyDE (Gao et al. 2022), arxiv 2212.10496
- **Prior-art note:** none. Compare with §3 Step-Back — both rewrite the query but in opposite directions (HyDE toward a concrete answer, Step-Back toward an abstract principle). Potentially fusable via RRF.

#### Query2Doc (query expansion by pseudo-answer generation)

- **Gist:** Generate a short pseudo-document about the query and concatenate it with the original before embedding.
- **Miss-mode killed:** paraphrase, lexical
- **Where it lives:** query
- **Token cost:** 1-per-query
- **Paper(s):** Query2Doc (Wang et al. 2023), arxiv 2303.07678
- **Prior-art note:** none. Redundant with HyDE; nullifies when stacked.

#### Self-RAG (on-demand retrieval with reflection tokens)

- **Gist:** The model decides at each generation step whether to retrieve, and emits critique tokens evaluating each retrieved passage before using it.
- **Miss-mode killed:** context (irrelevant retrieval poisoning generation), scale (skip retrieval when not needed)
- **Where it lives:** query (inside the generation loop)
- **Token cost:** many
- **Paper(s):** Self-RAG (2023), arxiv 2310.11511
- **Prior-art note:** none.

#### CRAG (corrective retrieval with quality estimator)

- **Gist:** Score each retrieved candidate's quality; if all are low, fall back to web search and continue.
- **Miss-mode killed:** sparse-precedent (recovery when the store has nothing useful)
- **Where it lives:** query
- **Token cost:** 1-per-query + fallback cost
- **Paper(s):** CRAG (2024), arxiv 2401.15884
- **Prior-art note:** none.

#### Adaptive-RAG (route by query difficulty)

- **Gist:** A small classifier decides whether to answer directly, retrieve once, or enter an iterative loop, based on estimated query difficulty.
- **Miss-mode killed:** operational-efficiency — prevents spending iterative-retrieval budget on easy queries
- **Where it lives:** query (front gate)
- **Token cost:** 1-per-query (classifier) + variable downstream
- **Paper(s):** Adaptive-RAG (2024), arxiv 2403.14403
- **Prior-art note:** §A path_memory_phase211_deferred (MAGMA per-view router) is the same family; deferred for view-granularity reasons. Adaptive-RAG's difficulty axis is a different routing signal than MAGMA's view axis — potentially complementary.

#### FLARE (forward-looking retrieval)

- **Gist:** Generate the next sentence speculatively; if low-confidence tokens appear, retrieve on them and regenerate.
- **Miss-mode killed:** context, compositional
- **Where it lives:** query (inside generation)
- **Token cost:** many
- **Paper(s):** FLARE (2023), arxiv 2305.06983
- **Prior-art note:** none. Adjacent to §3 IRCoT — FLARE triggers retrieval on confidence, IRCoT on every reasoning step.

### 7. Prior-art-derived entries

Mechanisms tried in this repo (or adjacent work) that are not cleanly captured by families 1–6. Refuted mechanisms count — a refutation is as useful as a confirmation.

#### Score-space weighted fusion (Dijkstra τ)

- **Gist:** Combine scores from multiple retrievers by a weighted sum with a temperature τ that sharpens or softens the combination.
- **Insight:** RRF operates on ranks; this operates on raw scores. τ controls how sharply differences in score translate into differences in combined rank — low τ behaves like "only the top scorer matters," high τ behaves like averaging. Runs cheaply alongside Dijkstra-style path weighting.
- **Miss-mode killed:** lexical (multi-retriever blend); complements RRF when score scales ARE comparable (same-family encoders).
- **Where it lives:** query (fusion stage)
- **Token cost:** none
- **Pairs with:** Dijkstra path traversal; same-family encoders
- **Conflicts with:** Reciprocal-rank fusion (choose one or run both — path_memory_phase216 ships RRF opt-in alongside τ-fusion as default)
- **Paper(s):** no external paper; framework-internal from path-memory Phase 2.8.
- **Prior-art note:** §A path_memory_phase28 — Dijkstra tmp=0.5, wfusion τ=0.2 is the default runner. Option M (alternative fusion) regressed. Phase 2.13 kept this default under BGE-base.

#### Spreading activation with tier inhibition (SYNAPSE variant — refuted)

- **Gist:** Activate seed nodes at full weight, spread to neighbors at reduced weight, apply inhibition so later tiers don't dominate.
- **Insight:** The cognitive-psych idea that a concept activates related concepts proportional to edge weight, damped by hop distance. Classic on dense human semantic graphs. Tier inhibition adds a penalty on tier-2+ nodes so the walk doesn't run away from the seed neighborhood.
- **Miss-mode it was supposed to kill:** analogy, context, compositional
- **Where it lives:** query
- **Token cost:** none
- **Pairs with:** (n/a — refuted on this repo's graphs)
- **Conflicts with:** Personalized PageRank (PPR is the non-inhibited, density-weighted cousin and outperforms SYNAPSE here)
- **Paper(s):** cognitive psychology tradition (Collins & Loftus 1975); path_memory_phase210 tried a SYNAPSE variant.
- **Prior-art note:** §A path_memory_phase210 — eval-A regresses, eval-B flat. Small-graph dilution + tier-2 inhibition harm. Ships opt-in only. Refutation is specific to tier-inhibition + small-graph dilution; PPR proper (family 2) is still open.

#### Edge-hotness soft-gate (refuted)

- **Gist:** Use per-edge access counts as a soft penalty on traversal weight — hot edges cheapen, cold edges burden.
- **Insight:** Since edge weights concentrate on repeat-user arcs (phase 2.9's edgeRatio 7.72× observation), bias traversal toward hot edges to exploit that concentration.
- **Miss-mode it was supposed to kill:** scale, compositional
- **Where it lives:** query
- **Token cost:** none
- **Pairs with:** (n/a — refuted as a gate; the hotness OBSERVATION is valid, soft-gating on it is not)
- **Conflicts with:** eval-C retrieval (+35% latency, flat coverage)
- **Paper(s):** no external source; framework-internal from path-memory Phase 4a.
- **Prior-art note:** §A path_memory_phase4a — ships disabled-only. Phase 2.9 shows hotness exists; Phase 4a shows exploiting it as a soft-gate regresses. Node-level reinforcement (family 5) is the open slot, not more edge-gating.

#### Per-query view router (MAGMA — deferred)

- **Gist:** Route each query to one of N pre-defined retrieval "views" (anchor sets, encoders, filters) based on query features.
- **Insight:** Views are whole-query retrieval configurations. A router maps a query signature to a view. Idea is that different queries prefer different retrieval shapes.
- **Miss-mode it was supposed to kill:** compositional, analogy
- **Where it lives:** query (front-gate)
- **Token cost:** 1-per-query (router classifier)
- **Pairs with:** Planner-led retrieval (PlanRAG); Adaptive-RAG routing
- **Conflicts with:** whole-query views when the right granularity is sub-query — this is why MAGMA dry-run produced only 1 unique tuple across 38 probes.
- **Paper(s):** no external paper by this name; framework-internal from Phase 2.11.
- **Prior-art note:** §A path_memory_phase211_deferred — deferred until after Phase 7. Diagnosis: view granularity was too coarse. PlanRAG-style leaf-level routing (family 3) is the open variant.

#### Topic-linking cross-domain plugin

- **Gist:** A shared plugin layer that extracts topics from memories at ingest and uses them as a cheap structured index across all domains.
- **Insight:** Topics are a coarse but free signal — every memory has some, they cut the candidate pool fast, and they compose with any retrieval mechanism downstream. The trick is making topic extraction itself tiered (stable-id lookup → vector-only mode → full LLM) so 90% of memories never trigger an LLM call.
- **Miss-mode killed:** scale (candidate pool pruning), schema (cross-domain interop)
- **Where it lives:** ingest (tiered topic extraction) + query (topic-based score boost)
- **Token cost:** amortized — most ingests hit the fast tiers
- **Pairs with:** Entity-anchored retrieval; community summaries (topics are the flat precursor)
- **Conflicts with:** none known
- **Paper(s):** no external paper; framework-internal.
- **Prior-art note:** §F commits e2b816a (topic-linking plugin), b98b09d (cache afterTopicLink mutations + memory.topics field), cb9ccbe (vector-only tier), 57ffca4 (Tier 0 stable-id lookup), 2249076 (perf: cut WDI ingestion ~47% via topic tiers), 776e1af (topic-based score boosting). Core framework primitive.

#### MMR budget-filling for diverse top-k

- **Gist:** Instead of returning the top-k by score, fill a budget by greedily picking the next candidate that maximizes `λ·score − (1−λ)·max-similarity-to-already-picked`.
- **Insight:** Top-k by raw score often returns several near-duplicates. MMR (Maximal Marginal Relevance) trades a little score for diversity, so the returned set covers more of the candidate space. Useful when the answer needs evidence from several angles.
- **Miss-mode killed:** aggregation (near-duplicates crowding out diverse evidence)
- **Where it lives:** query (post-ranking selection)
- **Token cost:** none
- **Pairs with:** Atomic-fact extraction (atomic facts benefit most from diversity); cascade rerank (MMR at the final step)
- **Conflicts with:** point-lookup queries where the right answer is a single near-duplicate cluster.
- **Paper(s):** Carbonell & Goldstein "The Use of MMR, Diversity-Based Reranking" (SIGIR 1998).
- **Prior-art note:** §C commit 77e6484 — MMR budget filling + question-aware indexing for KB noise reduction. Already in-tree.

#### Intent-classification front-gate (refuted)

- **Gist:** Classify the query's intent up-front and hard-filter the candidate pool to memories tagged with that intent.
- **Insight:** A priori it sounds like free precision. In practice, classification accuracy caps the ceiling — at 43% classification accuracy, 57% of queries get the wrong pool.
- **Miss-mode it was supposed to kill:** scale, schema
- **Where it lives:** query (front-gate)
- **Token cost:** 1-per-query (classifier)
- **Pairs with:** (n/a — refuted at the whole-query level; per-sub-query variant is open, see §3 Sub-question fanout)
- **Conflicts with:** recall — a misclassified query is dead.
- **Paper(s):** kb_architecture_testing (repo note).
- **Prior-art note:** §C kb_architecture_testing (43% classification accuracy); commits aecc0e4 (added), bfe91d0 (wired), 106b0a3 (removed as a negative result). The refutation is at OUTER-question granularity; sub-question granularity (Self-Ask/IRCoT) is the open slot.

#### Similarity batching for ingest-time LLM decisions

- **Gist:** Before making supersession/merge/contradiction decisions, cluster pending inbox items by embedding + request context, and pass each cluster to the LLM as a batch.
- **Insight:** Decisions like "does A supersede B?" require the LLM to see both. Rather than asking once per candidate pair, cluster first so each LLM call sees a coherent group and makes all pairwise decisions in one call. Amortizes the per-call overhead and produces consistent decisions across the cluster.
- **Miss-mode killed:** operational-scale at ingest; also improves supersession precision by giving the LLM full context
- **Where it lives:** ingest (pre-LLM clustering)
- **Token cost:** reduces total tokens vs. per-pair calls
- **Pairs with:** Atomic-fact extraction; Contradiction-based supersession; Reflection rollup
- **Conflicts with:** strict streaming ingest where each item must commit immediately
- **Paper(s):** no external paper; framework-internal from inbox redesign.
- **Prior-art note:** §B similarity_batching + project_inbox_redesign; inbox_error_handling documents retry/quarantine policies.

#### Parametric memory via learned codebook (GRACE — mixed)

- **Gist:** Store memories as key-value entries in a small LLM's own weights (codebook keys lookup, value tokens decoded).
- **Insight:** Instead of external retrieval, bake the facts into model parameters directly and let the model recall them natively. Avoids the embedding/retrieval mismatch entirely.
- **Miss-mode it was supposed to kill:** paraphrase (native recall), context
- **Where it lives:** ingest (codebook edit) + query (model-native)
- **Token cost:** high at ingest (codebook learning), low at query
- **Pairs with:** (experimental — not yet composed with other primitives)
- **Conflicts with:** external retrieval (they're alternatives, not additives)
- **Paper(s):** GRACE-style parametric memory literature; framework-internal Phase 0.4.
- **Prior-art note:** §E lm_as_memory_phase04 — 23/23 exact-form recall, 0/20 Q&A-form recall. Codebook learned perfectly but L2 lookup defeated by template wrapping. Parametric line survives as exploratory; not in the current retrieval-stack conversation. Next external analog: WISE (Phase 0.5).

## Appendix — Miss-mode coverage

| Miss-mode | Entries that claim to kill it |
|---|---|
| paraphrase | Atomic-fact extraction; Contradiction supersession; LLM-extracted graph; Synonym edges; Entity-anchored retrieval; ColBERT MaxSim; Cross-encoder rerank; Step-Back; SPIRES/KGGen; HyDE; Query2Doc; Temporal-graph retrieval; GRACE |
| temporal | Contradiction supersession; Valid-time intervals; Forgetting curve; Bi-temporal edges; Event-valid-interval gating; Supersession-by-valid-time; Exponential decay; Ebbinghaus; Temporal-graph retrieval; MemTree |
| aggregation | Contradiction supersession; Reflection rollup; Community summaries; Map-reduce global query; Dual-index; Listwise LLM rerank; Sub-question fanout; MMR; RAPTOR; MemTree |
| context | Context-preserving decomposition; MemGPT paging; Passage nodes; Recognition-memory triple filter; IRCoT; Self-RAG; FLARE; GRACE |
| schema | SPIRES/KGGen; Triplex; Topic-linking |
| lexical | LLM-extracted graph; Synonym edges; Entity-anchored retrieval; Recognition-memory triple filter; ColBERT MaxSim; Cross-encoder rerank; RRF; Score-space weighted fusion; SPIRES/KGGen; Query2Doc |
| decomposition | Atomic-fact extraction; Context-preserving decomposition; LLM-extracted graph; Entity-anchored retrieval; Personalized PageRank |
| granularity | Atomic-fact extraction; Passage nodes; Dual-index |
| analogy | Context-preserving decomposition; Dual-index; Step-Back |
| sparse-precedent | MemGPT paging; Reflection rollup; Personalized PageRank; CRAG |
| compositional | Personalized PageRank; Sub-question fanout; IRCoT; PlanRAG; FLARE |
| scale | MemGPT paging; Reflection rollup; Forgetting curve; Community summaries; Map-reduce; Incremental graph update; PlanRAG; Exponential decay; Self-RAG; RAPTOR; MemTree; Topic-linking |

### Research gaps

_Miss-modes with zero entries:_ none — every miss-mode in the taxonomy has ≥3 atlas entries claiming to kill it.

_Coverage observations:_

- **paraphrase** and **scale** are the most-covered miss-modes (13 and 12 entries respectively) — these are the "classic" retrieval problems attacked from many angles.
- **schema**, **granularity**, and **analogy** are the least-covered (3 entries each). If any domain recipe leans on these, the supporting evidence is thin; consider pulling survey-stub entries into deep entries before committing.
- **sparse-precedent** has only 4 entries and no pure-algorithmic kill — MemGPT paging, reflection, PPR, and CRAG all require at least one LLM call. If Silentium's analogy queries fall into this bucket, the "LLM only as last resort" principle faces its sharpest test here.
