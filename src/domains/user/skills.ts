import type { DomainSkill } from '../../core/types.ts'
import { USER_DOMAIN_ID, USER_TAG } from './types.ts'

const userData: DomainSkill = {
  id: 'user-data',
  name: 'How to store user facts',
  description: 'Tells external agents how to find or create a user node, store user facts, and link existing memories to a user',
  scope: 'external',
  content: `# User Data Storage

User facts are memory entries linked to a user node in the graph. The user node is a dedicated SurrealDB record identified by a \`userId\` string.

## Finding or Creating a User Node

Before storing a user fact, ensure the user node exists:

\`\`\`ts
const userId = requestContext.userId // string — the external user identifier
const userNodeId = \`user:\${userId}\`

const existing = await context.graph.getNode(userNodeId)
if (!existing) {
  await context.graph.createNodeWithId(userNodeId, { userId })
}
\`\`\`

## Storing a User Fact

Write a memory entry and link it to the user node with an \`about_user\` edge:

\`\`\`ts
const memoryId = await context.writeMemory({
  content: factText, // human-readable fact about the user
  tags: ['${USER_TAG}/preference'], // use a category sub-tag (see below)
  ownership: {
    domain: '${USER_DOMAIN_ID}',
    attributes: {},
  },
})

await context.graph.relate(memoryId, 'about_user', userNodeId)
\`\`\`

## Tag Categories

Use sub-tags under \`${USER_TAG}/\` to categorise user facts:

| Tag | Use for |
|-----|---------|
| \`${USER_TAG}/identity\` | Name, location, pronouns, and other identity attributes |
| \`${USER_TAG}/preference\` | Likes, dislikes, settings, communication style |
| \`${USER_TAG}/expertise\` | Skills, knowledge areas, professional background |
| \`${USER_TAG}/goal\` | Current objectives, aspirations, ongoing projects |

Example:

\`\`\`ts
// Identity fact
await context.writeMemory({
  content: 'User prefers to be addressed as Alex.',
  tags: ['${USER_TAG}/identity'],
  ownership: { domain: '${USER_DOMAIN_ID}', attributes: {} },
})

// Preference fact
await context.writeMemory({
  content: 'User prefers concise responses without bullet lists.',
  tags: ['${USER_TAG}/preference'],
  ownership: { domain: '${USER_DOMAIN_ID}', attributes: {} },
})
\`\`\`

## Linking Existing Memories to a User

If a memory already exists and should be associated with a user, create the edge directly:

\`\`\`ts
await context.graph.relate(existingMemoryId, 'about_user', userNodeId)
\`\`\`
`,
}

const userQuery: DomainSkill = {
  id: 'user-query',
  name: 'How to query user data',
  description: 'Tells external agents how to find user facts by category, retrieve all data linked to a user, and get a profile summary',
  scope: 'external',
  content: `# User Data Querying

## Finding User Facts by Category

Retrieve user facts filtered by a tag category:

\`\`\`ts
const preferences = await context.getMemories({
  tags: ['${USER_TAG}/preference'],
  domains: ['${USER_DOMAIN_ID}'],
})
\`\`\`

Available category tags: \`${USER_TAG}/identity\`, \`${USER_TAG}/preference\`, \`${USER_TAG}/expertise\`, \`${USER_TAG}/goal\`

## Getting All Data Linked to a User

Use \`getNodeEdges\` to find all memories connected to the user node:

\`\`\`ts
const userId = requestContext.userId
const userNodeId = \`user:\${userId}\`

const edges = await context.getNodeEdges(userNodeId, 'in')
// edges[].in contains the memory IDs pointing to this user node

const memoryIds = edges.map(e => String(e.in)).filter(id => id.startsWith('memory:'))
const memories = await Promise.all(memoryIds.map(id => context.getMemory(id)))
\`\`\`

## Searching User Facts by Content

Use full-text or semantic search scoped to the user domain:

\`\`\`ts
const results = await context.search({
  text: queryText,
  tags: ['${USER_TAG}'],
  domains: ['${USER_DOMAIN_ID}'],
})
\`\`\`

## Getting the Profile Summary

A consolidated profile summary is stored with the \`${USER_TAG}/profile-summary\` tag:

\`\`\`ts
const summaries = await context.getMemories({
  tags: ['${USER_TAG}/profile-summary'],
  domains: ['${USER_DOMAIN_ID}'],
})

// The summary linked to a specific user can be identified by following
// its outgoing about_user edge to the matching user node
\`\`\`
`,
}

const userProfile: DomainSkill = {
  id: 'user-profile',
  name: 'Internal user profile consolidation',
  description: 'Internal skill describing how user profile summaries are synthesised from accumulated user facts',
  scope: 'internal',
  content: `# User Profile Consolidation (Internal)

This skill describes the consolidation logic run by the user domain schedule.

## Finding All User Nodes

Query the graph for all user records:

\`\`\`ts
const userNodes = await context.graph.query<{ id: string; userId: string }[]>(
  'SELECT id, userId FROM user'
)
\`\`\`

## Collecting Linked Data

For each user node, retrieve all incoming edges and resolve the linked memories:

\`\`\`ts
const edges = await context.getNodeEdges(userNodeId, 'in')
const memoryIds = edges.map(e => String(e.in)).filter(id => id.startsWith('memory:'))

const contents: string[] = []
for (const memId of memoryIds) {
  const memory = await context.getMemory(memId)
  if (memory) contents.push(memory.content)
}
\`\`\`

## LLM Synthesis

Pass the collected memory contents to the LLM consolidation helper:

\`\`\`ts
const summary = await context.llm.consolidate(contents)
\`\`\`

## Summary Update Strategy

- If a profile summary memory already exists for this user (identified by having an \`about_user\` edge pointing to the same user node), update its content in place:

\`\`\`ts
await context.graph.updateNode(existingSummaryId, { content: summary })
\`\`\`

- If no summary exists, create a new memory and link it to the user node:

\`\`\`ts
const summaryId = await context.writeMemory({
  content: summary,
  tags: ['${USER_TAG}/profile-summary'],
  ownership: { domain: '${USER_DOMAIN_ID}', attributes: {} },
})
await context.graph.relate(summaryId, 'about_user', userNodeId)
\`\`\`

## Notes

- Skip user nodes that have no linked memory edges.
- Skip LLM calls when there is no content to consolidate.
- Do not duplicate summaries — always check for an existing summary before creating a new one.
`,
}

export const userSkills: DomainSkill[] = [userData, userQuery, userProfile]
