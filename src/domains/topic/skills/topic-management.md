# Topic Management
Topics are memory entries owned by the `topic` domain with the `topic` tag.

## Creating a Topic
Before creating a topic, check for existing similar topics:

`node memory-domain search "<proposed-topic>" --tags topic --min-score 0.8`

If no sufficiently similar topic exists, create one:

```sh
node memory-domain write --domain topic \
  --text "<topic-name>" \
  --tags topic \
  --attr name="<topic-name>" \
  --attr status=active \
  --attr mentionCount=0
```

## Linking a Memory to a Topic

Use a graph edge to associate any memory with a topic:
`node memory-domain graph relate <memory-id> <topic-id> about_topic --domain topic`

## Creating Topic Hierarchy
Mark a topic as a subtopic of a parent:
`node memory-domain graph relate <child-topic-id> <parent-topic-id> subtopic_of --domain topic`

## Updating Mention Count
When a topic is referenced, update its attributes:
`node memory-domain memory <topic-id> update --attr mentionCount=5`

## Topic Statuses

| Status | Meaning |
|--------|---------|
| `active` | Currently in use |
| `stale` | Not referenced recently |
| `merged` | Merged into another topic |
