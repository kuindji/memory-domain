import type { Surreal } from 'surrealdb'
import type { SharedSchema, DomainSchema, NodeDef, EdgeDef, FieldDef, IndexDef } from './types.ts'

interface RegisteredNode {
  name: string
  fields: FieldDef[]
  contributors: string[]
}

interface RegisteredEdge extends EdgeDef {
  contributors: string[]
}

class SchemaRegistry {
  private registeredNodes = new Map<string, RegisteredNode>()
  private registeredEdges = new Map<string, RegisteredEdge>()

  constructor(private db: Surreal) {}

  async registerCore(): Promise<void> {
    // Core node tables
    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS memory SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS content ON memory TYPE string;
      DEFINE FIELD IF NOT EXISTS embedding ON memory TYPE option<array<float>>;
      DEFINE FIELD IF NOT EXISTS event_time ON memory TYPE option<int>;
      DEFINE FIELD IF NOT EXISTS created_at ON memory TYPE int;
      DEFINE FIELD IF NOT EXISTS token_count ON memory TYPE int DEFAULT 0;
    `)

    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS tag SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS label ON tag TYPE string;
      DEFINE FIELD IF NOT EXISTS created_at ON tag TYPE int;
    `)

    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS domain SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS name ON domain TYPE string;
      DEFINE FIELD IF NOT EXISTS settings ON domain TYPE option<object> FLEXIBLE;
    `)

    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS meta SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS value ON meta TYPE option<string>;
    `)

    // Core edge tables
    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS tagged SCHEMALESS TYPE RELATION IN memory OUT tag;
      DEFINE TABLE IF NOT EXISTS child_of SCHEMALESS TYPE RELATION IN tag OUT tag;
      DEFINE TABLE IF NOT EXISTS owned_by SCHEMALESS TYPE RELATION IN memory OUT domain;
    `)

    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS reinforces SCHEMALESS TYPE RELATION IN memory OUT memory;
      DEFINE FIELD IF NOT EXISTS strength ON reinforces TYPE option<float>;
      DEFINE FIELD IF NOT EXISTS detected_at ON reinforces TYPE option<int>;
      DEFINE TABLE IF NOT EXISTS contradicts SCHEMALESS TYPE RELATION IN memory OUT memory;
      DEFINE FIELD IF NOT EXISTS strength ON contradicts TYPE option<float>;
      DEFINE FIELD IF NOT EXISTS detected_at ON contradicts TYPE option<int>;
      DEFINE TABLE IF NOT EXISTS summarizes SCHEMALESS TYPE RELATION IN memory OUT memory;
      DEFINE TABLE IF NOT EXISTS refines SCHEMALESS TYPE RELATION IN memory OUT memory;
    `)

    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS has_rule SCHEMALESS TYPE RELATION IN tag OUT domain;
    `)

    // Track core nodes in memory
    this.registeredNodes.set('memory', {
      name: 'memory',
      fields: [
        { name: 'content', type: 'string' },
        { name: 'embedding', type: 'option<array<float>>' },
        { name: 'event_time', type: 'option<int>' },
        { name: 'created_at', type: 'int' },
        { name: 'token_count', type: 'int' },
      ],
      contributors: ['core'],
    })
    this.registeredNodes.set('tag', {
      name: 'tag',
      fields: [
        { name: 'label', type: 'string' },
        { name: 'created_at', type: 'int' },
      ],
      contributors: ['core'],
    })
    this.registeredNodes.set('domain', {
      name: 'domain',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'settings', type: 'option<object>' },
      ],
      contributors: ['core'],
    })
    this.registeredNodes.set('meta', {
      name: 'meta',
      fields: [
        { name: 'value', type: 'option<string>' },
      ],
      contributors: ['core'],
    })
  }

  async registerShared(schema: SharedSchema): Promise<void> {
    await this.registerNodes(schema.nodes, 'shared')
    await this.registerEdges(schema.edges, 'shared')
  }

  async registerDomain(domainId: string, schema: DomainSchema): Promise<void> {
    await this.registerNodes(schema.nodes, domainId)
    await this.registerEdges(schema.edges, domainId)
  }

  getRegisteredNode(name: string): RegisteredNode | undefined {
    return this.registeredNodes.get(name)
  }

  private async registerNodes(nodes: NodeDef[], contributor: string): Promise<void> {
    for (const node of nodes) {
      const existing = this.registeredNodes.get(node.name)

      if (existing) {
        // Check for field type conflicts
        for (const field of node.fields) {
          const existingField = existing.fields.find(f => f.name === field.name)
          if (existingField && existingField.type !== field.type) {
            throw new Error(
              `Schema conflict: "${contributor}" defines ${node.name}.${field.name} as ${field.type}, ` +
              `but it's already defined as ${existingField.type} by ${existing.contributors.join(', ')}`
            )
          }
        }

        // Add new fields only
        const newFields = node.fields.filter(
          f => !existing.fields.some(ef => ef.name === f.name)
        )
        for (const field of newFields) {
          await this.defineField(node.name, field)
        }
        existing.fields.push(...newFields)
        existing.contributors.push(contributor)
      } else {
        // New table
        const schemafull = node.schemafull !== false
        await this.db.query(`DEFINE TABLE IF NOT EXISTS ${node.name} ${schemafull ? 'SCHEMAFULL' : 'SCHEMALESS'}`)
        for (const field of node.fields) {
          await this.defineField(node.name, field)
        }
        if (node.indexes) {
          for (const idx of node.indexes) {
            await this.defineIndex(node.name, idx)
          }
        }
        this.registeredNodes.set(node.name, {
          name: node.name,
          fields: [...node.fields],
          contributors: [contributor],
        })
      }
    }
  }

  private async registerEdges(edges: EdgeDef[], contributor: string): Promise<void> {
    for (const edge of edges) {
      const existing = this.registeredEdges.get(edge.name)
      if (existing) {
        existing.contributors.push(contributor)
        if (edge.fields) {
          for (const field of edge.fields) {
            const existingField = existing.fields?.find(f => f.name === field.name)
            if (!existingField) {
              await this.defineField(edge.name, field)
              existing.fields = existing.fields ?? []
              existing.fields.push(field)
            }
          }
        }
      } else {
        const inTypes = Array.isArray(edge.from) ? edge.from.join(' | ') : edge.from
        const outTypes = Array.isArray(edge.to) ? edge.to.join(' | ') : edge.to
        await this.db.query(`DEFINE TABLE IF NOT EXISTS ${edge.name} SCHEMALESS TYPE RELATION IN ${inTypes} OUT ${outTypes}`)
        if (edge.fields) {
          for (const field of edge.fields) {
            await this.defineField(edge.name, field)
          }
        }
        this.registeredEdges.set(edge.name, { ...edge, contributors: [contributor] })
      }
    }
  }

  private async defineField(table: string, field: FieldDef): Promise<void> {
    const typeStr = field.required === false ? `option<${field.type}>` : field.type
    let query = `DEFINE FIELD IF NOT EXISTS ${field.name} ON ${table} TYPE ${typeStr}`
    if (field.default !== undefined) {
      query += ` DEFAULT ${typeof field.default === 'string' ? `'${field.default}'` : field.default}`
    }
    if (field.computed) {
      query += ` VALUE ${field.computed}`
    }
    await this.db.query(query)
  }

  private async defineIndex(table: string, idx: IndexDef): Promise<void> {
    let query = `DEFINE INDEX IF NOT EXISTS ${idx.name} ON ${table} FIELDS ${idx.fields.join(', ')}`
    if (idx.type === 'unique') {
      query += ' UNIQUE'
    } else if (idx.type === 'hnsw') {
      const dim = (idx.config?.dimension as number) ?? 384
      const dist = (idx.config?.dist as string) ?? 'COSINE'
      query += ` HNSW DIMENSION ${dim} DIST ${dist}`
    } else if (idx.type === 'search') {
      const analyzer = (idx.config?.analyzer as string) ?? 'ascii'
      query += ` SEARCH ANALYZER ${analyzer} BM25`
    }
    await this.db.query(query)
  }
}

export { SchemaRegistry }
