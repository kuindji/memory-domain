import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SearchEngine } from '../src/core/search-engine.ts'
import { GraphStore } from '../src/core/graph-store.ts'
import { SchemaRegistry } from '../src/core/schema-registry.ts'
import { createTestDb } from './helpers.ts'
import type { Surreal } from 'surrealdb'

describe('SearchEngine', () => {
  let db: Surreal
  let store: GraphStore
  let search: SearchEngine

  beforeEach(async () => {
    db = await createTestDb()
    const schema = new SchemaRegistry(db)
    await schema.registerCore()
    store = new GraphStore(db)
    search = new SearchEngine(store)
  })

  afterEach(async () => {
    await db.close()
  })

  describe('graph search', () => {
    test('finds memories connected via edges', async () => {
      await store.createNodeWithId('tag:test_topic', { label: 'test_topic', created_at: Date.now() })
      const m1 = await store.createNode('memory', {
        content: 'first memory about topic',
        created_at: Date.now(),
        token_count: 5,
      })
      const m2 = await store.createNode('memory', {
        content: 'second memory about topic',
        created_at: Date.now(),
        token_count: 5,
      })
      await store.relate(m1, 'tagged', 'tag:test_topic')
      await store.relate(m2, 'tagged', 'tag:test_topic')

      await store.createNode('memory', {
        content: 'unrelated memory',
        created_at: Date.now(),
        token_count: 5,
      })

      const result = await search.search({
        mode: 'graph',
        tags: ['test_topic'],
        limit: 10,
      })

      expect(result.entries.length).toBe(2)
      expect(result.mode).toBe('graph')
    })
  })

  describe('fulltext search', () => {
    test('finds memories by keyword', async () => {
      await store.createNode('memory', {
        content: 'scheduled maintenance window for database servers',
        created_at: Date.now(),
        token_count: 7,
      })
      await store.createNode('memory', {
        content: 'weather forecast for tomorrow',
        created_at: Date.now(),
        token_count: 5,
      })

      const result = await search.search({
        text: 'database maintenance',
        mode: 'fulltext',
        limit: 10,
      })

      expect(result.entries.length).toBeGreaterThanOrEqual(1)
      expect(result.entries[0].content).toContain('maintenance')
    })
  })

  describe('token budget', () => {
    test('limits results by token budget', async () => {
      for (let i = 0; i < 10; i++) {
        await store.createNode('memory', {
          content: `Memory number ${i} with some content`,
          created_at: Date.now(),
          token_count: 100,
        })
      }

      const result = await search.search({
        mode: 'graph',
        limit: 10,
        tokenBudget: 350,
      })

      expect(result.entries.length).toBeLessThanOrEqual(3)
      expect(result.totalTokens).toBeLessThanOrEqual(350)
    })
  })

  describe('hybrid search', () => {
    test('combines fulltext and graph results', async () => {
      await store.createNodeWithId('tag:hybrid_tag', { label: 'hybrid_tag', created_at: Date.now() })

      const m1 = await store.createNode('memory', {
        content: 'hybrid search memory tagged item',
        created_at: Date.now(),
        token_count: 5,
      })
      await store.relate(m1, 'tagged', 'tag:hybrid_tag')

      await store.createNode('memory', {
        content: 'hybrid search memory from fulltext only',
        created_at: Date.now(),
        token_count: 6,
      })

      const result = await search.search({
        mode: 'hybrid',
        text: 'hybrid search memory',
        tags: ['hybrid_tag'],
        limit: 10,
        weights: { vector: 0.0, fulltext: 0.5, graph: 0.5 },
      })

      expect(result.mode).toBe('hybrid')
      expect(result.entries.length).toBeGreaterThanOrEqual(1)
    })

    test('returns results even with only graph component', async () => {
      await store.createNodeWithId('tag:only_graph', { label: 'only_graph', created_at: Date.now() })
      const m1 = await store.createNode('memory', {
        content: 'graph only memory',
        created_at: Date.now(),
        token_count: 3,
      })
      await store.relate(m1, 'tagged', 'tag:only_graph')

      const result = await search.search({
        mode: 'hybrid',
        tags: ['only_graph'],
        limit: 10,
        weights: { vector: 0.0, fulltext: 0.0, graph: 1.0 },
      })

      expect(result.entries.length).toBe(1)
    })
  })

  describe('minScore filter', () => {
    test('filters out entries below minScore', async () => {
      // Create memories that will have low scores via graph recency fallback (0.5)
      for (let i = 0; i < 3; i++) {
        await store.createNode('memory', {
          content: `low score memory ${i}`,
          created_at: Date.now(),
          token_count: 4,
        })
      }

      const result = await search.search({
        mode: 'graph',
        limit: 10,
        minScore: 0.9, // Higher than recency score of 0.5
      })

      expect(result.entries.length).toBe(0)
    })

    test('keeps entries above minScore', async () => {
      await store.createNodeWithId('tag:high', { label: 'high', created_at: Date.now() })
      const m = await store.createNode('memory', {
        content: 'high score memory',
        created_at: Date.now(),
        token_count: 3,
      })
      await store.relate(m, 'tagged', 'tag:high')

      const result = await search.search({
        mode: 'graph',
        tags: ['high'],
        limit: 10,
        minScore: 0.1, // Tag-based graph search scores 1.0
      })

      expect(result.entries.length).toBe(1)
    })
  })

  describe('config-driven defaults', () => {
    test('uses configured defaultMode when query omits mode', async () => {
      const configuredSearch = new SearchEngine(store, { defaultMode: 'fulltext' })

      await store.createNode('memory', {
        content: 'config driven default mode test memory',
        created_at: Date.now(),
        token_count: 6,
      })

      const result = await configuredSearch.search({
        text: 'config driven default',
        limit: 10,
      })

      expect(result.mode).toBe('fulltext')
    })

    test('query mode overrides configured defaultMode', async () => {
      const configuredSearch = new SearchEngine(store, { defaultMode: 'fulltext' })

      await store.createNode('memory', {
        content: 'override mode test memory',
        created_at: Date.now(),
        token_count: 5,
      })

      const result = await configuredSearch.search({
        mode: 'graph',
        limit: 10,
      })

      expect(result.mode).toBe('graph')
    })

    test('uses configured defaultWeights for search', async () => {
      const configuredSearch = new SearchEngine(store, {
        defaultWeights: { vector: 0.0, fulltext: 0.8, graph: 0.2 },
      })

      await store.createNode('memory', {
        content: 'custom weights test memory content',
        created_at: Date.now(),
        token_count: 6,
      })

      const result = await configuredSearch.search({
        text: 'custom weights test',
        limit: 10,
      })

      // Should work without errors and return results using configured weights
      expect(result.mode).toBe('hybrid')
      expect(result.entries.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('domain ownership filter', () => {
    test('filters by domain ownership', async () => {
      await store.createNodeWithId('domain:alpha', { name: 'Alpha' })
      await store.createNodeWithId('domain:beta', { name: 'Beta' })

      const m1 = await store.createNode('memory', {
        content: 'alpha domain memory',
        created_at: Date.now(),
        token_count: 3,
      })
      const m2 = await store.createNode('memory', {
        content: 'beta domain memory',
        created_at: Date.now(),
        token_count: 3,
      })

      await store.relate(m1, 'owned_by', 'domain:alpha', { attributes: {}, owned_at: Date.now() })
      await store.relate(m2, 'owned_by', 'domain:beta', { attributes: {}, owned_at: Date.now() })

      const result = await search.search({
        mode: 'graph',
        domains: ['alpha'],
        limit: 10,
      })

      expect(result.entries.length).toBe(1)
      expect(result.entries[0].content).toBe('alpha domain memory')
    })
  })
})
