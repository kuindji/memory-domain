import type { CommandHandler } from '../types.ts'

const graphCommand: CommandHandler = async (engine, parsed) => {
  const [subcommand, ...rest] = parsed.args

  if (!subcommand) {
    return { output: { error: 'Subcommand is required: edges, relate, unrelate, traverse' }, exitCode: 1 }
  }

  if (subcommand === 'edges') {
    const [nodeId] = rest
    if (!nodeId) return { output: { error: 'Node id is required' }, exitCode: 1 }

    const directionFlag = parsed.flags['direction'] as string | undefined
    const direction =
      directionFlag === 'in' || directionFlag === 'out' || directionFlag === 'both'
        ? directionFlag
        : undefined

    const domainId = parsed.flags['domain'] as string | undefined
    const edges = await engine.getEdges(nodeId, direction, domainId)
    return { output: { edges }, exitCode: 0 }
  }

  if (subcommand === 'relate') {
    const [from, to, edgeType] = rest
    if (!from || !to || !edgeType) {
      return { output: { error: 'relate requires <from> <to> <edge-type>' }, exitCode: 1 }
    }
    const domain = parsed.flags['domain'] as string | undefined
    if (!domain) return { output: { error: '--domain is required for relate' }, exitCode: 1 }

    const attr = parsed.flags['attr']
    const attrs = attr && typeof attr === 'object' ? (attr as Record<string, unknown>) : undefined

    const edgeId = await engine.relate(from, to, edgeType, domain, attrs)
    return { output: { edgeId }, exitCode: 0 }
  }

  if (subcommand === 'unrelate') {
    const [from, to, edgeType] = rest
    if (!from || !to || !edgeType) {
      return { output: { error: 'unrelate requires <from> <to> <edge-type>' }, exitCode: 1 }
    }
    await engine.unrelate(from, to, edgeType)
    return { output: { removed: true }, exitCode: 0 }
  }

  if (subcommand === 'traverse') {
    const [startId] = rest
    if (!startId) return { output: { error: 'Start node id is required' }, exitCode: 1 }

    const edgesFlag = parsed.flags['edges'] as string | undefined
    if (!edgesFlag) return { output: { error: '--edges is required for traverse' }, exitCode: 1 }

    const edgeTypes = edgesFlag.split(',')
    const depthFlag = parsed.flags['depth']
    const depth = depthFlag !== undefined ? Number(depthFlag) : undefined
    const domainId = parsed.flags['domain'] as string | undefined

    const nodes = await engine.traverse(startId, edgeTypes, depth, domainId)
    return { output: { nodes }, exitCode: 0 }
  }

  return { output: { error: `Unknown subcommand: ${subcommand}` }, exitCode: 1 }
}

export { graphCommand }
