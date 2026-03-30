import type { DomainContext } from '../../core/types.ts'
import { USER_DOMAIN_ID, USER_TAG } from './types.ts'

export async function consolidateUserProfile(context: DomainContext): Promise<void> {
  // Find all user nodes
  const userNodes = await context.graph.query<{ id: string; userId: string }[]>(
    'SELECT id, userId FROM user'
  )
  if (!userNodes || userNodes.length === 0) return

  for (const userNode of userNodes) {
    const userNodeId = String(userNode.id)

    // Get all incoming edges to this user node
    const edges = await context.getNodeEdges(userNodeId, 'in')
    if (edges.length === 0) continue

    // Collect memory content from linked nodes
    const memoryIds = edges.map(e => String(e.in)).filter(id => id.startsWith('memory:'))
    const uniqueIds = [...new Set(memoryIds)]

    const contents: string[] = []
    for (const memId of uniqueIds) {
      const memory = await context.getMemory(memId)
      if (memory) contents.push(memory.content)
    }
    if (contents.length === 0) continue

    // Synthesize profile summary
    const summary = await context.llm.consolidate(contents)
    if (!summary.trim()) continue

    // Find existing profile summary for this user
    const existingSummaries = await context.getMemories({
      tags: [`${USER_TAG}/profile-summary`],
      domains: [USER_DOMAIN_ID],
    })

    let existingSummaryId: string | undefined
    for (const existing of existingSummaries) {
      const summaryEdges = await context.getNodeEdges(existing.id, 'out')
      const linksToUser = summaryEdges.some(e => String(e.out) === userNodeId)
      if (linksToUser) {
        existingSummaryId = existing.id
        break
      }
    }

    if (existingSummaryId) {
      await context.graph.updateNode(existingSummaryId, { content: summary })
    } else {
      const summaryId = await context.writeMemory({
        content: summary,
        tags: [`${USER_TAG}/profile-summary`],
        ownership: { domain: USER_DOMAIN_ID, attributes: {} },
      })
      await context.graph.relate(summaryId, 'about_user', userNodeId, { domain: USER_DOMAIN_ID })
    }
  }
}
