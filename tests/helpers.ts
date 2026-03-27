import { Surreal } from 'surrealdb'
import { createNodeEngines } from '@surrealdb/node'
import type { LLMAdapter, EmbeddingAdapter, ScoredMemory } from '../src/core/types.ts'

let dbCounter = 0

export async function createTestDb(): Promise<Surreal> {
  const db = new Surreal({ engines: createNodeEngines() })
  await db.connect('mem://')
  await db.use({ namespace: 'test', database: `test_${++dbCounter}_${Date.now()}` })
  return db
}

export class MockLLMAdapter implements LLMAdapter {
  extractResult: string[] = []
  consolidateResult = ''
  generateResult = ''
  synthesizeResult = ''

  extract(): Promise<string[]> {
    return Promise.resolve(this.extractResult)
  }
  consolidate(): Promise<string> {
    return Promise.resolve(this.consolidateResult)
  }
  generate(_prompt: string): Promise<string> {
    return Promise.resolve(this.generateResult)
  }
  synthesize(
    _query: string,
    _memories: ScoredMemory[],
    _tagContext?: string[]
  ): Promise<string> {
    return Promise.resolve(this.synthesizeResult)
  }
}

export class MockEmbeddingAdapter implements EmbeddingAdapter {
  readonly dimension = 4

  embed(text: string): Promise<number[]> {
    let hash = 0
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
    }
    const vec = [
      Math.sin(hash),
      Math.cos(hash),
      Math.sin(hash * 2),
      Math.cos(hash * 2),
    ]
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    return Promise.resolve(vec.map(v => v / norm))
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)))
  }
}
