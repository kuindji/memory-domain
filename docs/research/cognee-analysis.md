# Cognee Source Code Analysis

Research conducted 2026-03-29. Cognee v latest (github.com/topoteretes/cognee, ~14.8k stars).

## Overview

Cognee is a knowledge engine that transforms raw data into structured knowledge graphs through an ECL (Extract, Cognify, Load) pipeline. It supports custom OWL ontologies, custom Pydantic data models, and fully custom processing pipelines. Of all existing AI memory frameworks, Cognee has the most flexible and pipeline-oriented approach to knowledge organization.

## Architecture

### Public API

Four primary operations:
- `cognee.add()` — data ingestion (text, files, URLs, binary)
- `cognee.cognify()` — graph construction via LLM extraction
- `cognee.search()` — knowledge retrieval (19 search types)
- `cognee.delete() / cognee.update()` — data management

### Storage

Requires three separate databases:
- **Relational** (PostgreSQL/SQLite) — data records, users, ACLs, pipeline status
- **Vector** (LanceDB/Qdrant/Weaviate/PGVector) — embeddings for semantic search
- **Graph** (KuzuDB/Neo4j/Neptune) — knowledge graph nodes and edges

### Data Flow

```
Raw Input → add() → Data records in relational DB
                         ↓
                    cognify() pipeline:
                    1. classify_documents (file type → document type)
                    2. extract_chunks (paragraph-based splitting)
                    3. extract_graph (LLM entity/relationship extraction)
                    4. summarize_text (hierarchical summaries)
                    5. add_data_points (store in graph + vector DBs)
                         ↓
                    search() retrieval:
                    1. Embed query
                    2. Vector search across collections
                    3. Graph projection + traversal
                    4. Triplet importance ranking
                    5. Context assembly → LLM completion
```

## Interesting Patterns

### 1. Pipeline Composition Model

Tasks are wrapped callables (async functions, generators, coroutines) chained into ordered lists:

```python
Task(extract_entities)
Task(index_data_points, task_config={"batch_size": 100})
```

Each task's output flows as input to the next, with batch size awareness — each task knows the next task's batch size and batches results accordingly. Data items within a batch are processed in parallel via `asyncio.gather()`.

Supports four execution modes: coroutine, async generator, sync generator, plain function. Mode is auto-detected at initialization.

Pipelines support:
- Incremental loading (skip already-processed data via content hash)
- Pipeline caching (skip re-running completed pipelines)
- Distributed execution via Modal (serverless, up to 50 containers)
- Background execution with queue-based status reporting

### 2. Ontology Grounding via Fuzzy Matching

Loads OWL/RDF ontologies via RDFLib. During graph extraction, each extracted entity is fuzzy-matched (cutoff 0.8 via `difflib.get_close_matches`) against OWL Classes. Matched entities get canonical URI-derived names (eliminating cross-document duplicates). BFS traversal attaches ontology subgraph relationships.

Every node gets `ontology_valid = True/False`. If no ontology is provided, everything gets `False` and the graph is built purely from LLM extraction. The ontology is strictly additive — safe to introduce incrementally.

### 3. Feedback Weight System (Self-Improving Memory)

Every `DataPoint` has a `feedback_weight: float = 0.5`. When users rate search results, weights are updated using exponential moving average:

```
new_weight = old_weight + alpha * (normalized_rating - old_weight)
```

Where `normalized_rating = (feedback_score - 1) / 4` maps 1-5 ratings to [0, 1].

This applies to both nodes and edges — the graph itself learns which relationships are valuable. Weights are clipped to [0, 1].

### 4. Triplet Importance Scoring

The core hybrid search is triplet-centric. It doesn't just search nodes — it searches node+edge+node triplets as units:

```
score(triplet) = distance(node1) + distance(edge) + distance(node2)
```

Edges are embedded as `"{start_text}→{edge_text}→{end_text}"` and stored in vector collections alongside entity embeddings. This means relationships are semantically searchable, not just structurally traversable.

Non-matching elements use a configurable `triplet_distance_penalty` (default 3.5) instead of vector distance, ensuring vector-matched elements are prioritized.

### 5. Multi-Round Cascade Extraction

Entity extraction isn't single-shot. Multiple rounds are run where each round receives the previous round's output as context:

```python
for round in range(n_rounds):  # default 2
    new_nodes = await extract_nodes(text, previous_nodes=existing_nodes)
    existing_nodes.update(new_nodes)
```

Three stages per round: node extraction, relationship name identification, triplet (edge) extraction. This catches entities the LLM missed in the first pass.

### 6. Iterative Context Extension Search

The `GraphCompletionContextExtensionRetriever` runs up to 4 rounds of search refinement:

1. Search with original query, get results, generate completion
2. Use completion as new search query, get more results
3. Merge, deduplicate, check convergence
4. Stop when no new triplets found

### 7. Access Timestamp Tracking

Every retrieval updates `access_timestamps` on touched nodes via `update_node_access_timestamps()`. Enables usage-based analytics and can feed into importance scoring.

### 8. Provenance Stamping

Every extracted DataPoint records:
- `source_pipeline` — which pipeline created it
- `source_task` — which specific step
- `source_user` — who initiated it
- `source_node_set` — organizational grouping

Recursive stamping of nested DataPoints enables full audit trails.

### 9. In-Memory Graph Projection

The `CogneeGraph` class projects a subgraph from the database into memory for fast operations:
- Nodes maintain numpy status arrays for dimension-based filtering
- Vector distances stored as lists to support multi-query scenarios
- `heapq.nsmallest` for efficient top-k triplet selection

### 10. Natural Language to Cypher

The `NaturalLanguageRetriever` converts natural language queries to Cypher with a multi-attempt strategy (default 3 attempts). Failed attempts are accumulated as context for the next attempt, providing error feedback to the LLM.

### 11. Multi-Tenancy

Full ACL system with principals (users + tenants), permissions (read/write/delete/share), scoped to datasets. Queries check ACLs before returning results. Tenant context is set as global context variables during pipeline execution.

## Relevance to active-memory

### Patterns Worth Considering

1. **Triplet embeddings** — embedding edges as searchable units. Highest-value pattern. active-memory indexes memories (nodes) in vector search but edges aren't independently searchable via embeddings. Embedding relationship triplets could significantly improve search for architectural queries like "what talks to order-processor."

2. **Feedback weights with EMA** — complements existing decay scoring naturally. When a memory is retrieved and found useful, its score could be boosted; when retrieved and irrelevant, penalized.

3. **Access timestamp tracking** — low-effort addition with high value for scoring. active-memory has decay scoring based on creation time but doesn't track when memories are actually retrieved. Tracking access patterns would allow frequently-retrieved memories to decay more slowly.

4. **Provenance stamping** — important for the project-knowledge domain where multiple sources write memories (agent sessions, commit scanner, drift detector).

5. **Multi-round extraction** — for `processInboxItem`, a multi-round approach could catch entity references the agent missed. Round 1: extract obvious entities. Round 2: given round 1's entities as context, find related entities and implicit relationships.

6. **Iterative context extension** — `buildContext` could use a similar iterative approach for complex queries. Initial results expand the search in subsequent rounds until convergence.

7. **Pipeline composability** — useful if `processInboxItem` grows complex, but premature to abstract now.

### What Cognee Does NOT Have (active-memory advantages)

| active-memory has | Cognee doesn't |
|---|---|
| Domain-based ownership with ref-counted deletion | Flat dataset isolation only |
| Decay scoring with configurable curves | No time-based decay (only feedback weights) |
| Dedup/reinforcement on ingest (vector similarity) | Dedup by content hash, no semantic reinforcement |
| Inbox processor with scheduler (background) | Pipeline execution is user-triggered only |
| Single DB (SurrealDB) for everything | Requires 3 separate databases |
| Bounded domain contexts with custom search hooks | No per-domain search customization |
| `supersedes` edges for decision evolution | No mechanism for fact versioning |

### Architectural Differences

| Aspect | Cognee | active-memory |
|---|---|---|
| Philosophy | Document → Graph (ETL pipeline) | Agent → Memory (continuous capture) |
| Data flow | Batch pipeline: add → cognify → search | Streaming: ingest → process → search |
| Processing | User-triggered pipelines | Background inbox processor + scheduler |
| Graph model | Generic KnowledgeGraph (any Pydantic model) | Domain-specific schemas (typed nodes/edges) |
| Search | 19 search types, retriever factory | Hybrid search with domain hooks |
| Storage | 3 separate DBs (relational + vector + graph) | Single SurrealDB |
| Multi-tenancy | Full ACL system (read/write/delete/share) | Domain-level ownership |
| Scale target | Enterprise (Modal distributed execution) | Project-level (single agent/team) |
