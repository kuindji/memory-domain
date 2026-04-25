import type { PgClient } from "../adapters/pg/types.js";
import type { DomainSchema, NodeDef, EdgeDef, FieldDef, IndexDef } from "./types.js";
import { translateFieldType, defaultLiteral } from "./sql/types.js";

interface RegisteredNode {
    name: string;
    fields: FieldDef[];
    indexes: IndexDef[];
    contributors: string[];
}

interface RegisteredEdge extends EdgeDef {
    contributors: string[];
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

const CORE_NODE_TABLES = ["memory", "tag", "domain", "meta"] as const;

const CORE_EDGES = [
    "tagged",
    "child_of",
    "owned_by",
    "reinforces",
    "contradicts",
    "summarizes",
    "refines",
    "has_rule",
] as const;

class SchemaRegistry {
    private registeredNodes = new Map<string, RegisteredNode>();
    private registeredEdges = new Map<string, RegisteredEdge>();

    constructor(private db: PgClient) {}

    async registerCore(embeddingDimension?: number): Promise<void> {
        await this.db.run("CREATE EXTENSION IF NOT EXISTS vector");

        // memory table — embedding column only added when dimension is known,
        // matching the existing prime-then-define HNSW pattern.
        const embeddingCol = embeddingDimension
            ? `embedding vector(${embeddingDimension}),`
            : "";
        await this.db.run(`
            CREATE TABLE IF NOT EXISTS memory (
                id text PRIMARY KEY,
                content text NOT NULL,
                ${embeddingCol}
                event_time bigint,
                created_at bigint NOT NULL,
                token_count bigint NOT NULL DEFAULT 0,
                request_context jsonb,
                structured_data jsonb,
                metadata jsonb,
                answers_question text
            );
        `);

        // If memory existed without embedding column and dim is now known, add it.
        if (embeddingDimension) {
            const exists = await this.columnExists("memory", "embedding");
            if (!exists) {
                await this.db.run(
                    `ALTER TABLE memory ADD COLUMN embedding vector(${embeddingDimension})`,
                );
            }
        }

        await this.db.run(`
            CREATE TABLE IF NOT EXISTS tag (
                id text PRIMARY KEY,
                label text NOT NULL,
                created_at bigint NOT NULL
            );
        `);

        await this.db.run(`
            CREATE TABLE IF NOT EXISTS domain (
                id text PRIMARY KEY,
                name text NOT NULL,
                settings jsonb
            );
        `);

        await this.db.run(`
            CREATE TABLE IF NOT EXISTS meta (
                id text PRIMARY KEY,
                value text
            );
        `);

        // Edge tables.
        for (const edge of CORE_EDGES) {
            await this.createEdgeTable(edge, []);
        }
        // Edge-specific fields.
        await this.addEdgeFields("reinforces", [
            { name: "strength", type: "option<float>" },
            { name: "detected_at", type: "option<int>" },
        ]);
        await this.addEdgeFields("contradicts", [
            { name: "strength", type: "option<float>" },
            { name: "detected_at", type: "option<int>" },
        ]);
        // owned_by carries domain-supplied attributes + a write timestamp.
        await this.addEdgeFields("owned_by", [
            { name: "attributes", type: "option<object>" },
            { name: "owned_at", type: "option<int>" },
        ]);

        // Indexes on edge endpoints. Two indexes per edge (one per direction)
        // to support traversal from either side.
        for (const edge of CORE_EDGES) {
            await this.createSimpleIndex(edge, `idx_${edge}_in`, ["in_id"]);
            await this.createSimpleIndex(edge, `idx_${edge}_out`, ["out_id"]);
        }

        if (embeddingDimension) {
            await this.ensureHnswIndex(
                "memory",
                "idx_memory_embedding",
                "embedding",
                embeddingDimension,
            );
        }

        // Fulltext: replace Surreal BM25 with Postgres tsvector GIN. Functional
        // index avoids materializing a tsvector column. The Postgres planner
        // matches `to_tsvector('english', content) @@ ...` queries against this.
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_memory_content
             ON memory USING GIN (to_tsvector('english', content))`,
        );
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_memory_answers_question
             ON memory USING GIN (to_tsvector('english', coalesce(answers_question, '')))`,
        );
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_memory_event_time ON memory (event_time)`,
        );

        // Track registered shape for verifyIndexes / introspection.
        const coreMemoryIndexes: IndexDef[] = [
            { name: "idx_memory_content", fields: ["content"], type: "search" },
            { name: "idx_memory_answers_question", fields: ["answers_question"], type: "search" },
            { name: "idx_memory_event_time", fields: ["event_time"] },
        ];
        if (embeddingDimension) {
            coreMemoryIndexes.unshift({
                name: "idx_memory_embedding",
                fields: ["embedding"],
                type: "hnsw",
                config: { dimension: embeddingDimension, dist: "COSINE" },
            });
        }

        this.registeredNodes.set("memory", {
            name: "memory",
            fields: [
                { name: "content", type: "string" },
                { name: "embedding", type: "option<array<float>>" },
                { name: "event_time", type: "option<int>" },
                { name: "created_at", type: "int" },
                { name: "token_count", type: "int" },
                { name: "request_context", type: "option<object>" },
                { name: "structured_data", type: "option<object>" },
                { name: "metadata", type: "option<object>" },
                { name: "answers_question", type: "option<string>" },
            ],
            indexes: coreMemoryIndexes,
            contributors: ["core"],
        });
        this.registeredNodes.set("tag", {
            name: "tag",
            fields: [
                { name: "label", type: "string" },
                { name: "created_at", type: "int" },
            ],
            indexes: [],
            contributors: ["core"],
        });
        this.registeredNodes.set("domain", {
            name: "domain",
            fields: [
                { name: "name", type: "string" },
                { name: "settings", type: "option<object>" },
            ],
            indexes: [],
            contributors: ["core"],
        });
        this.registeredNodes.set("meta", {
            name: "meta",
            fields: [{ name: "value", type: "option<string>" }],
            indexes: [],
            contributors: ["core"],
        });

        for (const edge of CORE_EDGES) {
            this.registeredEdges.set(edge, {
                name: edge,
                from: this.coreEdgeFromTo(edge).from,
                to: this.coreEdgeFromTo(edge).to,
                contributors: ["core"],
            });
        }
    }

    async registerDomain(domainId: string, schema: DomainSchema): Promise<void> {
        await this.registerNodes(schema.nodes, domainId);
        await this.registerEdges(schema.edges, domainId);
    }

    getRegisteredNode(name: string): RegisteredNode | undefined {
        return this.registeredNodes.get(name);
    }

    getRegisteredEdgeNames(): string[] {
        return [...this.registeredEdges.keys()];
    }

    private coreEdgeFromTo(edge: (typeof CORE_EDGES)[number]): { from: string; to: string } {
        switch (edge) {
            case "tagged":
                return { from: "memory", to: "tag" };
            case "child_of":
                return { from: "tag", to: "tag" };
            case "owned_by":
                return { from: "memory", to: "domain" };
            case "reinforces":
            case "contradicts":
            case "summarizes":
            case "refines":
                return { from: "memory", to: "memory" };
            case "has_rule":
                return { from: "tag", to: "domain" };
        }
    }

    private async registerNodes(nodes: NodeDef[], contributor: string): Promise<void> {
        for (const node of nodes) {
            if (!IDENT_RE.test(node.name)) {
                throw new Error(`Invalid node name: "${node.name}"`);
            }
            const existing = this.registeredNodes.get(node.name);

            if (existing) {
                for (const field of node.fields) {
                    const existingField = existing.fields.find((f) => f.name === field.name);
                    if (existingField && existingField.type !== field.type) {
                        throw new Error(
                            `Schema conflict: "${contributor}" defines ${node.name}.${field.name} as ${field.type}, ` +
                                `but it's already defined as ${existingField.type} by ${existing.contributors.join(", ")}`,
                        );
                    }
                }

                const newFields = node.fields.filter(
                    (f) => !existing.fields.some((ef) => ef.name === f.name),
                );
                for (const field of newFields) {
                    await this.addColumn(node.name, field);
                }
                existing.fields.push(...newFields);

                if (node.indexes) {
                    for (const idx of node.indexes) {
                        await this.defineIndex(node.name, idx);
                        if (!existing.indexes.some((i) => i.name === idx.name)) {
                            existing.indexes.push(idx);
                        }
                    }
                }

                existing.contributors.push(contributor);
            } else {
                await this.createNodeTable(node);
                if (node.indexes) {
                    for (const idx of node.indexes) {
                        await this.defineIndex(node.name, idx);
                    }
                }
                this.registeredNodes.set(node.name, {
                    name: node.name,
                    fields: [...node.fields],
                    indexes: node.indexes ? [...node.indexes] : [],
                    contributors: [contributor],
                });
            }
        }
    }

    private async registerEdges(edges: EdgeDef[], contributor: string): Promise<void> {
        for (const edge of edges) {
            if (!IDENT_RE.test(edge.name)) {
                throw new Error(`Invalid edge name: "${edge.name}"`);
            }
            const existing = this.registeredEdges.get(edge.name);
            if (existing) {
                existing.contributors.push(contributor);
                if (edge.fields) {
                    for (const field of edge.fields) {
                        const existingField = existing.fields?.find((f) => f.name === field.name);
                        if (!existingField) {
                            await this.addColumn(edge.name, field);
                            existing.fields = existing.fields ?? [];
                            existing.fields.push(field);
                        }
                    }
                }
            } else {
                await this.createEdgeTable(edge.name, edge.fields ?? []);
                await this.createSimpleIndex(edge.name, `idx_${edge.name}_in`, ["in_id"]);
                await this.createSimpleIndex(edge.name, `idx_${edge.name}_out`, ["out_id"]);
                this.registeredEdges.set(edge.name, { ...edge, contributors: [contributor] });
            }
        }
    }

    private async createNodeTable(node: NodeDef): Promise<void> {
        const cols: string[] = ["id text PRIMARY KEY"];
        for (const field of node.fields) {
            cols.push(this.fieldColumnSql(field));
        }
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${node.name} (${cols.join(", ")})`);
    }

    private async createEdgeTable(name: string, fields: FieldDef[]): Promise<void> {
        const cols: string[] = [
            "id text PRIMARY KEY",
            "in_id text NOT NULL",
            "out_id text NOT NULL",
        ];
        for (const field of fields) {
            cols.push(this.fieldColumnSql(field));
        }
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`);
    }

    private async addEdgeFields(table: string, fields: FieldDef[]): Promise<void> {
        for (const field of fields) {
            const exists = await this.columnExists(table, field.name);
            if (!exists) await this.addColumn(table, field);
        }
    }

    private fieldColumnSql(field: FieldDef): string {
        const { pgType, nullable } = translateFieldType(field.type);
        const required = field.required !== false && !nullable;
        let sql = `${field.name} ${pgType}`;
        if (required) sql += " NOT NULL";
        if (field.default !== undefined && field.default !== null) {
            sql += ` DEFAULT ${defaultLiteral(field.default)}`;
        }
        return sql;
    }

    private async addColumn(table: string, field: FieldDef): Promise<void> {
        const { pgType, nullable } = translateFieldType(field.type);
        const required = field.required !== false && !nullable;
        let sql = `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${field.name} ${pgType}`;
        if (required) sql += " NOT NULL";
        if (field.default !== undefined && field.default !== null) {
            sql += ` DEFAULT ${defaultLiteral(field.default)}`;
        }
        await this.db.run(sql);
    }

    private async columnExists(table: string, column: string): Promise<boolean> {
        const rows = await this.db.query<{ exists: boolean }>(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = $1 AND column_name = $2
             ) AS exists`,
            [table, column],
        );
        return rows[0]?.exists === true;
    }

    /**
     * HNSW lifecycle. Three cases:
     *   1. Index absent — create.
     *   2. Index present, dimension matches — no-op.
     *   3. Index present, dimension mismatch — drop + recreate.
     *
     * pgvector encodes dimension on the column type, not the index. We compare
     * the column's typmod to detect drift.
     */
    private async ensureHnswIndex(
        table: string,
        name: string,
        field: string,
        dimension: number,
    ): Promise<void> {
        // Postgres column type for vector(N) reports as e.g. "vector(384)".
        const colInfo = await this.db.query<{ data_type: string }>(
            `SELECT format_type(atttypid, atttypmod) AS data_type
             FROM pg_attribute
             WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`,
            [table, field],
        );
        const currentType = colInfo[0]?.data_type ?? "";
        const dimMatch = currentType.match(/vector\((\d+)\)/);
        const currentDim = dimMatch ? Number(dimMatch[1]) : null;

        if (currentDim !== dimension) {
            // Either column is missing dim entirely or has wrong one. Recast.
            await this.db.run(`DROP INDEX IF EXISTS ${name}`);
            await this.db.run(
                `ALTER TABLE ${table} ALTER COLUMN ${field} TYPE vector(${dimension})`,
            );
        }

        const idxRows = await this.db.query<{ indexdef: string }>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = $1 AND tablename = $2`,
            [name, table],
        );
        const existing = idxRows[0]?.indexdef ?? "";
        const isHnsw = /USING\s+hnsw/i.test(existing);
        if (isHnsw && currentDim === dimension) return;

        if (existing) await this.db.run(`DROP INDEX IF EXISTS ${name}`);
        await this.db.run(
            `CREATE INDEX ${name} ON ${table} USING hnsw (${field} vector_cosine_ops)`,
        );
    }

    private async createSimpleIndex(
        table: string,
        name: string,
        fields: string[],
    ): Promise<void> {
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${fields.join(", ")})`,
        );
    }

    private async defineIndex(table: string, idx: IndexDef): Promise<void> {
        if (idx.type === "hnsw") {
            const dim = (idx.config?.dimension as number) ?? 384;
            await this.ensureHnswIndex(table, idx.name, idx.fields[0], dim);
            return;
        }
        if (idx.type === "search") {
            // Functional GIN tsvector index. Combines all listed fields with
            // coalesce so nullable columns don't break to_tsvector.
            const expr = idx.fields
                .map((f) => `coalesce(${f}, '')`)
                .join(" || ' ' || ");
            await this.db.run(
                `CREATE INDEX IF NOT EXISTS ${idx.name}
                 ON ${table} USING GIN (to_tsvector('english', ${expr}))`,
            );
            return;
        }
        if (idx.type === "unique") {
            await this.db.run(
                `CREATE UNIQUE INDEX IF NOT EXISTS ${idx.name} ON ${table} (${idx.fields.join(", ")})`,
            );
            return;
        }
        await this.createSimpleIndex(table, idx.name, idx.fields);
    }

    /**
     * Verify that every registered edge table has its endpoint indexes and every
     * node table has its declared indexes. Returns missing identifiers.
     */
    async verifyIndexes(): Promise<string[]> {
        const missing: string[] = [];

        for (const [edgeName] of this.registeredEdges) {
            const expected = [`idx_${edgeName}_in`, `idx_${edgeName}_out`];
            const found = await this.listTableIndexes(edgeName);
            for (const name of expected) {
                if (!found.has(name)) missing.push(`${edgeName}.${name}`);
            }
        }

        for (const [nodeName, node] of this.registeredNodes) {
            if (node.indexes.length === 0) continue;
            const found = await this.listTableIndexes(nodeName);
            for (const idx of node.indexes) {
                if (!found.has(idx.name)) missing.push(`${nodeName}.${idx.name}`);
            }
        }

        return missing;
    }

    private async listTableIndexes(table: string): Promise<Set<string>> {
        try {
            const rows = await this.db.query<{ indexname: string }>(
                `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
                [table],
            );
            return new Set(rows.map((r) => r.indexname));
        } catch {
            return new Set();
        }
    }
}

export { SchemaRegistry, CORE_NODE_TABLES, CORE_EDGES };
