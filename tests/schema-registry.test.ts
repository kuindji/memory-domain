import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { SchemaRegistry } from '../src/core/schema-registry.ts'
import { createTestDb } from './helpers.ts'
import type { Surreal } from 'surrealdb'
import type { SharedSchema, DomainSchema } from '../src/core/types.ts'

describe('SchemaRegistry', () => {
  let db: Surreal
  let registry: SchemaRegistry

  beforeEach(async () => {
    db = await createTestDb()
    registry = new SchemaRegistry(db)
  })

  afterEach(async () => {
    await db.close()
  })

  describe('core schema', () => {
    test('registerCore creates memory, tag, domain, meta tables', async () => {
      await registry.registerCore()
      const ts = Date.now()
      await db.query('CREATE memory SET content = "test", created_at = $ts, token_count = 0', { ts })
      await db.query('CREATE tag SET label = "test", created_at = $ts', { ts })
      const [memories] = await db.query<[{ count: number }[]]>('SELECT count() FROM memory GROUP ALL')
      expect(memories[0].count).toBe(1)
    })

    test('registerCore is idempotent', async () => {
      await registry.registerCore()
      await registry.registerCore()
      // Should not throw
    })

    test('registerCore creates core edge tables', async () => {
      await registry.registerCore()
      const ts = Date.now()
      await db.query('CREATE memory:a SET content = "a", created_at = $ts, token_count = 0', { ts })
      await db.query('CREATE memory:b SET content = "b", created_at = $ts, token_count = 0', { ts })
      await db.query('RELATE memory:a->reinforces->memory:b SET strength = 0.9')
      const [edges] = await db.query<[{ count: number }[]]>('SELECT count() FROM reinforces GROUP ALL')
      expect(edges[0].count).toBe(1)
    })
  })

  describe('shared schema', () => {
    test('registerShared creates node and edge tables', async () => {
      await registry.registerCore()
      const schema: SharedSchema = {
        nodes: [
          { name: 'entity', fields: [{ name: 'name', type: 'string' }] }
        ],
        edges: [
          { name: 'related_to', from: 'entity', to: 'entity', fields: [] }
        ]
      }
      await registry.registerShared(schema)
      await db.query('CREATE entity SET name = "Alice"')
      const [entities] = await db.query<[{ count: number }[]]>('SELECT count() FROM entity GROUP ALL')
      expect(entities[0].count).toBe(1)
    })

    test('registerShared creates edge with fields', async () => {
      await registry.registerCore()
      const schema: SharedSchema = {
        nodes: [
          { name: 'entity', fields: [{ name: 'name', type: 'string' }] }
        ],
        edges: [
          { name: 'related_to', from: 'entity', to: 'entity', fields: [{ name: 'since', type: 'int' }] }
        ]
      }
      await registry.registerShared(schema)
      await db.query('CREATE entity:a SET name = "Alice"')
      await db.query('CREATE entity:b SET name = "Bob"')
      await db.query('RELATE entity:a->related_to->entity:b SET since = 2025')
      const [edges] = await db.query<[{ since: number }[]]>('SELECT since FROM related_to')
      expect(edges[0].since).toBe(2025)
    })
  })

  describe('domain schema', () => {
    test('registerDomain creates domain-specific tables', async () => {
      await registry.registerCore()
      const schema: DomainSchema = {
        nodes: [
          { name: 'resource', fields: [{ name: 'name', type: 'string' }, { name: 'kind', type: 'string' }] }
        ],
        edges: [
          { name: 'impacts', from: 'memory', to: 'resource', fields: [{ name: 'magnitude', type: 'float' }] }
        ]
      }
      await registry.registerDomain('test_domain', schema)
      await db.query('CREATE resource SET name = "sample", kind = "abstract"')
      const [resources] = await db.query<[{ count: number }[]]>('SELECT count() FROM resource GROUP ALL')
      expect(resources[0].count).toBe(1)
    })

    test('registerDomain extends existing node with new fields', async () => {
      await registry.registerCore()
      const shared: SharedSchema = {
        nodes: [{ name: 'entity', fields: [{ name: 'name', type: 'string' }] }],
        edges: []
      }
      await registry.registerShared(shared)
      const domainSchema: DomainSchema = {
        nodes: [{ name: 'entity', fields: [
          { name: 'name', type: 'string' },
          { name: 'bio', type: 'string', required: false }
        ] }],
        edges: []
      }
      await registry.registerDomain('extended', domainSchema)
      await db.query('CREATE entity SET name = "Alice", bio = "A test entity"')
      const [entities] = await db.query<[{ name: string; bio: string }[]]>('SELECT name, bio FROM entity')
      expect(entities[0].bio).toBe('A test entity')
    })

    test('registerDomain throws on field type conflict', async () => {
      await registry.registerCore()
      const shared: SharedSchema = {
        nodes: [{ name: 'entity', fields: [{ name: 'name', type: 'string' }] }],
        edges: []
      }
      await registry.registerShared(shared)
      const domainSchema: DomainSchema = {
        nodes: [{ name: 'entity', fields: [{ name: 'name', type: 'int' }] }],
        edges: []
      }
      expect(registry.registerDomain('bad_domain', domainSchema)).rejects.toThrow()
    })

    test('getRegisteredNode returns tracked node info', async () => {
      await registry.registerCore()
      const node = registry.getRegisteredNode('memory')
      expect(node).toBeDefined()
      expect(node!.name).toBe('memory')
      expect(node!.contributors).toEqual(['core'])
      expect(node!.fields.some(f => f.name === 'content')).toBe(true)
    })

    test('getRegisteredNode returns undefined for unknown', () => {
      expect(registry.getRegisteredNode('unknown')).toBeUndefined()
    })
  })
})
