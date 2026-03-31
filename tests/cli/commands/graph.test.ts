import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../../../src/core/engine.ts'
import { MockLLMAdapter } from '../../helpers.ts'
import { graphCommand } from '../../../src/cli/commands/graph.ts'
import type { ParsedCommand } from '../../../src/cli/types.ts'
import type { Edge, TraversalNode } from '../../../src/core/types.ts'

function makeParsed(
  args: string[] = [],
  flags: Record<string, string | boolean | Record<string, string>> = {}
): ParsedCommand {
  return {
    command: 'graph',
    args,
    flags: { ...flags },
  }
}

describe('graphCommand', () => {
  let engine: MemoryEngine
  let memA: string
  let memB: string

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_graph_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
    const a = await engine.writeMemory('Memory A', { domain: 'work' })
    const b = await engine.writeMemory('Memory B', { domain: 'work' })
    memA = a.id
    memB = b.id
  })

  afterEach(async () => {
    await engine.close()
  })

  it('returns error for missing subcommand', async () => {
    const parsed = makeParsed([])
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/Subcommand is required/)
  })

  it('relate creates an edge', async () => {
    const parsed = makeParsed(['relate', memA, memB, 'reinforces'], { domain: 'work' })
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { edgeId: string }
    expect(output.edgeId).toBeTruthy()
  })

  it('relate requires --domain', async () => {
    const parsed = makeParsed(['relate', memA, memB, 'reinforces'])
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(1)
    const output = result.output as { error: string }
    expect(output.error).toMatch(/--domain is required/)
  })

  it('relate accepts attributes', async () => {
    const parsed = makeParsed(['relate', memA, memB, 'reinforces'], {
      domain: 'work',
      attr: { note: 'related' },
    })
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { edgeId: string }
    expect(output.edgeId).toBeTruthy()
  })

  it('edges lists edges for a node', async () => {
    await engine.relate(memA, memB, 'reinforces', 'work')
    const parsed = makeParsed(['edges', memA])
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { edges: Edge[] }
    expect(Array.isArray(output.edges)).toBe(true)
    const hasEdge = output.edges.some(e => String(e.out) === memB)
    expect(hasEdge).toBe(true)
  })

  it('edges filters by direction', async () => {
    await engine.relate(memA, memB, 'reinforces', 'work')
    const parsed = makeParsed(['edges', memA], { direction: 'out' })
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { edges: Edge[] }
    expect(Array.isArray(output.edges)).toBe(true)
  })

  it('unrelate removes an edge', async () => {
    await engine.relate(memA, memB, 'reinforces', 'work')
    const parsed = makeParsed(['unrelate', memA, memB, 'reinforces'])
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { removed: boolean }
    expect(output.removed).toBe(true)
  })

  it('traverse follows edges', async () => {
    await engine.relate(memA, memB, 'reinforces', 'work')
    const parsed = makeParsed(['traverse', memA], { edges: 'reinforces' })
    const result = await graphCommand(engine, parsed)

    expect(result.exitCode).toBe(0)
    const output = result.output as { nodes: TraversalNode[] }
    expect(Array.isArray(output.nodes)).toBe(true)
    const found = output.nodes.some(n => n.id === memB)
    expect(found).toBe(true)
  })
})
