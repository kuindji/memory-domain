import { describe, test, expect } from "bun:test";
import { MemoryEngine } from "../src/core/engine.js";
import type {
    DomainRegistration,
    TableResult,
    FilterSpec,
    DomainContext,
} from "../src/core/types.js";
import { MockLLMAdapter } from "./helpers.js";

function makeTabularDomain(rows: TableResult["rows"]): DomainRegistration {
    return {
        domain: {
            id: "tabular",
            name: "Tabular Test",
            async processInboxBatch() {},
            search: {
                execute(
                    filter: FilterSpec,
                    _ctx: DomainContext,
                ): Promise<TableResult> {
                    const yearEq =
                        typeof filter.year === "number"
                            ? filter.year
                            : undefined;
                    const filtered =
                        yearEq !== undefined
                            ? rows.filter((r) => r.year === yearEq)
                            : rows;
                    return Promise.resolve({
                        rows: filtered,
                        columns: ["country", "year", "value"],
                        source: "test",
                    });
                },
            },
        },
    };
}

describe("MemoryEngine.searchTable", () => {
    test("dispatches to domain.search.execute and returns rows", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_searchtable_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(
            makeTabularDomain([
                { country: "USA", year: 2010, value: 100 },
                { country: "USA", year: 2011, value: 110 },
            ]),
        );

        const result = await engine.searchTable("tabular", { year: 2010 });
        expect(result.rows).toEqual([
            { country: "USA", year: 2010, value: 100 },
        ]);
        expect(result.columns).toEqual(["country", "year", "value"]);
        expect(result.source).toBe("test");

        await engine.close();
    });

    test("throws on unknown domain", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_searchtable_unknown_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        expect(engine.searchTable("does-not-exist", {})).rejects.toThrow(
            /unknown domain/i,
        );
        await engine.close();
    });

    test("throws on domain without search.execute", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_searchtable_rankonly_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain({
            domain: {
                id: "rank-only",
                name: "Rank Only",
                async processInboxBatch() {},
                search: { rank: (_q, c) => c },
            },
        });
        expect(engine.searchTable("rank-only", {})).rejects.toThrow(
            /does not support tabular/i,
        );
        await engine.close();
    });
});

describe("MemoryEngine.getDomainContext", () => {
    test("returns a DomainContext for a registered domain", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_getctx_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(
            makeTabularDomain([{ country: "USA", year: 2010, value: 100 }]),
        );

        const ctx = engine.getDomainContext("tabular");
        expect(ctx).toBeDefined();
        expect(ctx.domain).toBe("tabular");

        await engine.close();
    });

    test("throws on unknown domain", async () => {
        const engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_getctx_unknown_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        expect(() => engine.getDomainContext("does-not-exist")).toThrow(
            /unknown domain/i,
        );
        await engine.close();
    });
});
