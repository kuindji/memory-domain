import { describe, test, expect } from "bun:test";
import { createPgliteClient } from "../src/adapters/pg/pglite-adapter.js";
import { SchemaRegistry, CORE_EDGES } from "../src/core/schema-registry.js";

async function tableNames(
    db: Awaited<ReturnType<typeof createPgliteClient>>,
): Promise<Set<string>> {
    const rows = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    return new Set(rows.map((r) => r.table_name));
}

describe("SchemaRegistry over Postgres", () => {
    test("registerCore creates all node + edge tables", async () => {
        const db = await createPgliteClient();
        try {
            const reg = new SchemaRegistry(db);
            await reg.registerCore();

            const tables = await tableNames(db);
            for (const t of ["memory", "tag", "domain", "meta"]) {
                expect(tables.has(t)).toBe(true);
            }
            for (const e of CORE_EDGES) {
                expect(tables.has(e)).toBe(true);
            }
        } finally {
            await db.close();
        }
    });

    test("registerCore is idempotent", async () => {
        const db = await createPgliteClient();
        try {
            const reg1 = new SchemaRegistry(db);
            await reg1.registerCore(8);
            const reg2 = new SchemaRegistry(db);
            await reg2.registerCore(8); // second time should not throw
            const missing = await reg2.verifyIndexes();
            expect(missing).toEqual([]);
        } finally {
            await db.close();
        }
    });

    test("HNSW vector index built when dimension supplied", async () => {
        const db = await createPgliteClient();
        try {
            const reg = new SchemaRegistry(db);
            await reg.registerCore(4);

            const idx = await db.query<{ indexdef: string }>(
                `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_memory_embedding'`,
            );
            expect(idx).toHaveLength(1);
            expect(idx[0].indexdef).toMatch(/USING hnsw/i);
            expect(idx[0].indexdef).toMatch(/vector_cosine_ops/);

            // Vector column should be vector(4)
            const cols = await db.query<{ data_type: string }>(
                `SELECT format_type(atttypid, atttypmod) AS data_type
                 FROM pg_attribute
                 WHERE attrelid = 'memory'::regclass AND attname = 'embedding' AND NOT attisdropped`,
            );
            expect(cols[0].data_type).toBe("vector(4)");
        } finally {
            await db.close();
        }
    });

    test("HNSW dimension change triggers DROP+RECREATE", async () => {
        const db = await createPgliteClient();
        try {
            const reg = new SchemaRegistry(db);
            await reg.registerCore(4);
            // Re-run with different dimension on a fresh registry — simulates
            // what would happen if the embedder changed.
            await reg.registerCore(8);

            const cols = await db.query<{ data_type: string }>(
                `SELECT format_type(atttypid, atttypmod) AS data_type
                 FROM pg_attribute
                 WHERE attrelid = 'memory'::regclass AND attname = 'embedding' AND NOT attisdropped`,
            );
            expect(cols[0].data_type).toBe("vector(8)");
        } finally {
            await db.close();
        }
    });

    test("registerDomain adds custom node + edge tables", async () => {
        const db = await createPgliteClient();
        try {
            const reg = new SchemaRegistry(db);
            await reg.registerCore();
            await reg.registerDomain("region", {
                nodes: [
                    {
                        name: "country",
                        fields: [
                            { name: "iso3", type: "string" },
                            { name: "population", type: "option<int>" },
                            { name: "metrics", type: "option<object>" },
                        ],
                        indexes: [{ name: "idx_country_iso3", fields: ["iso3"] }],
                    },
                ],
                edges: [
                    {
                        name: "located_in",
                        from: "memory",
                        to: "country",
                        fields: [{ name: "weight", type: "option<float>" }],
                    },
                ],
            });

            const tables = await tableNames(db);
            expect(tables.has("country")).toBe(true);
            expect(tables.has("located_in")).toBe(true);

            // Custom edge endpoint indexes auto-created
            const idx = await db.query<{ indexname: string }>(
                `SELECT indexname FROM pg_indexes WHERE tablename = 'located_in' ORDER BY indexname`,
            );
            const names = idx.map((r) => r.indexname);
            expect(names).toContain("idx_located_in_in");
            expect(names).toContain("idx_located_in_out");

            // Insert a row to confirm the column types stick.
            await db.query(
                `INSERT INTO country (id, iso3, population, metrics) VALUES ($1, $2, $3, $4)`,
                ["country:usa", "USA", 331000000, JSON.stringify({ gdp: 25 })],
            );
            const got = await db.query<{ iso3: string; population: number; metrics: unknown }>(
                `SELECT iso3, population, metrics FROM country WHERE id = $1`,
                ["country:usa"],
            );
            expect(got[0].iso3).toBe("USA");
            expect(got[0].population).toBe(331000000);
            // PGLite returns jsonb as a parsed object.
            expect(got[0].metrics).toEqual({ gdp: 25 });
        } finally {
            await db.close();
        }
    });

    test("verifyIndexes flags missing endpoint indexes", async () => {
        const db = await createPgliteClient();
        try {
            const reg = new SchemaRegistry(db);
            await reg.registerCore();
            // Drop one endpoint index out from under the registry.
            await db.run(`DROP INDEX idx_tagged_in`);
            const missing = await reg.verifyIndexes();
            expect(missing).toContain("tagged.idx_tagged_in");
        } finally {
            await db.close();
        }
    });

    test("fulltext GIN index created and matches", async () => {
        const db = await createPgliteClient();
        try {
            const reg = new SchemaRegistry(db);
            await reg.registerCore();

            await db.query(`INSERT INTO memory (id, content, created_at) VALUES ($1, $2, $3)`, [
                "memory:1",
                "the quick brown fox jumps over the lazy dog",
                Date.now(),
            ]);
            const rows = await db.query<{ id: string }>(
                `SELECT id FROM memory
                 WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)`,
                ["fox"],
            );
            expect(rows.map((r) => r.id)).toEqual(["memory:1"]);
        } finally {
            await db.close();
        }
    });
});
