# Chat Processing (Internal)

Three scheduled tasks manage the working → episodic → semantic lifecycle.

## Promote Working Memory

Finds working memories that exceed capacity or age threshold per user.

1. Collect working memories ordered by `messageIndex`
2. LLM extraction: distill key facts and highlights
3. Create episodic memories (`chat/episodic`) with assigned weight
4. Link episodic → working via `summarizes` edges
5. Extract user-specific facts → push to User domain via `user-data` skill
6. Extract deeper semantic topics → link via `about_topic`
7. Release ownership claims on promoted working memories

## Consolidate Episodic

Clusters episodic memories by embedding similarity per user.

1. Find episodic memories for the user
2. Cluster by cosine similarity (threshold: configurable, default 0.7)
3. For clusters above minimum size: LLM summarizes into semantic memory
4. Link semantic → episodic via `summarizes` edges
5. Release ownership claims on consolidated episodic memories

## Prune Decayed

Removes episodic memories whose weight has decayed below threshold.

1. Calculate decayed weight: `weight * e^(-lambda * hoursSinceCreation)`
2. Release ownership claims on memories below prune threshold

## Decay Formula

```
decayedWeight = weight * Math.exp(-lambda * hoursSinceCreation)
```

- Episodic lambda: 0.01 (default) — decays to ~50% in ~69 hours
- Semantic lambda: 0.001 (default) — decays to ~50% in ~693 hours
- Prune threshold: 0.05 (default) — released when weight drops below this
