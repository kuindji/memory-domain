import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter, MockEmbeddingAdapter } from './helpers.ts'

describe('vector search', () => {
  let engine: MemoryEngine
  const embedding = new MockEmbeddingAdapter()

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_vec_${Date.now()}`,
      llm: new MockLLMAdapter(),
      embedding,
    })
  })

  afterEach(async () => {
    await engine.close()
  })

  test('ingest stores embedding on memory node', async () => {
    const result = await engine.ingest('vector test content')
    const node = await engine.getGraph().getNode(result.id!)
    expect(node?.embedding).toBeDefined()
    expect((node?.embedding as number[]).length).toBe(4)
  })

  test('vector search returns results by similarity', async () => {
    await engine.ingest('the cat sat on the mat')
    await engine.ingest('completely different topic about databases')

    const result = await engine.search({
      mode: 'vector',
      text: 'the cat sat on the mat',
      limit: 10,
    })

    expect(result.entries.length).toBeGreaterThanOrEqual(1)
    expect(result.mode).toBe('vector')
    if (result.entries.length > 1) {
      expect(result.entries[0].scores.vector).toBeGreaterThanOrEqual(
        result.entries[1].scores.vector!
      )
    }
  })

  test('vector search gracefully returns empty without adapter', async () => {
    const noVecEngine = new MemoryEngine()
    await noVecEngine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_novec_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })

    await noVecEngine.ingest('some text')
    const result = await noVecEngine.search({
      mode: 'vector',
      text: 'some text',
      limit: 10,
    })
    expect(result.entries.length).toBe(0)
    await noVecEngine.close()
  })

  test('hybrid search includes vector component when adapter present', async () => {
    await engine.ingest('hybrid vector test memory')

    const result = await engine.search({
      mode: 'hybrid',
      text: 'hybrid vector test',
      limit: 10,
      weights: { vector: 0.5, fulltext: 0.3, graph: 0.2 },
    })

    expect(result.entries.length).toBeGreaterThanOrEqual(1)
  })
})
