import { Surreal } from 'surrealdb'
import { createNodeEngines } from '@surrealdb/node'
import type { LLMAdapter, ScoredMemory } from '../src/core/types.ts'

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
