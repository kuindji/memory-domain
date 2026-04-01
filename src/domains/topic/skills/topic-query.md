# Topic Querying

## Finding Topics by Content
Use search filtered by the `topic` tag:
`node memory-domain search "<text-content>" --tags topic`

## Listing All Topics
`node memory-domain search "" --tags topic --limit 50`

## Finding Memories Linked to a Topic
Traverse `about_topic` edges inward to find all memories linked to a topic:
`node memory-domain graph traverse <topic-id> --edges about_topic --direction in --depth 1`

## Finding Child Topics
Traverse `subtopic_of` edges inward to find subtopics:
`node memory-domain graph traverse <parent-topic-id> --edges subtopic_of --direction in --depth 1`

## Finding Parent Topics
Traverse `subtopic_of` edges outward to find parent topics:
`node memory-domain graph traverse <child-topic-id> --edges subtopic_of --direction out --depth 1`
