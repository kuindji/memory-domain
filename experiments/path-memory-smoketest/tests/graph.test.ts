import { describe, test, expect } from "bun:test";
import { GraphIndex } from "../src/graph.js";
import type { Claim } from "../src/types.js";

function makeClaim(
    id: string,
    text: string,
    tokens: string[],
    embedding: number[],
    validFrom: number,
): Claim {
    return {
        id,
        text,
        tokens,
        embedding,
        validFrom,
        validUntil: Number.POSITIVE_INFINITY,
    };
}

describe("GraphIndex", () => {
    test("addClaim registers a node", () => {
        const g = new GraphIndex();
        const c = makeClaim("c1", "alex moves", ["alex", "moves"], [1, 0, 0], 1);
        g.addClaim(c);
        expect(g.nodeIds()).toEqual(["c1"]);
        expect(g.getNode("c1")).toBe(c);
    });

    test("lexical edges form between claims sharing tokens, weighted by jaccard", () => {
        const g = new GraphIndex({ semanticThreshold: 99 }); // disable semantic
        g.addClaim(makeClaim("c1", "alex moves to la", ["alex", "moves", "la"], [1, 0, 0], 1));
        g.addClaim(
            makeClaim("c2", "alex works at google", ["alex", "works", "google"], [0, 1, 0], 2),
        );
        const edges = g.neighbors("c1", ["lexical"]);
        expect(edges).toHaveLength(1);
        expect(edges[0].to).toBe("c2");
        // shared {alex} ∪ {alex, moves, la, works, google} = 5; jaccard = 1/5 = 0.2
        expect(edges[0].weight).toBeCloseTo(0.2, 5);
        expect(edges[0].meta?.sharedTokens).toEqual(["alex"]);
    });

    test("no lexical edge when no tokens shared", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        g.addClaim(makeClaim("c1", "alex", ["alex"], [1, 0, 0], 1));
        g.addClaim(makeClaim("c2", "bob", ["bob"], [0, 1, 0], 2));
        expect(g.neighbors("c1", ["lexical"])).toHaveLength(0);
    });

    test("semantic edges form when cosine ≥ threshold", () => {
        const g = new GraphIndex({ semanticThreshold: 0.5 });
        // identical embeddings (cosine = 1)
        g.addClaim(makeClaim("c1", "x", ["x"], [1, 0, 0], 1));
        g.addClaim(makeClaim("c2", "y", ["y"], [1, 0, 0], 2));
        const edges = g.neighbors("c1", ["semantic"]);
        expect(edges).toHaveLength(1);
        expect(edges[0].to).toBe("c2");
        expect(edges[0].weight).toBeCloseTo(1, 5);
    });

    test("no semantic edge below threshold", () => {
        const g = new GraphIndex({ semanticThreshold: 0.5 });
        g.addClaim(makeClaim("c1", "x", ["x"], [1, 0, 0], 1));
        g.addClaim(makeClaim("c2", "y", ["y"], [0, 1, 0], 2));
        expect(g.neighbors("c1", ["semantic"])).toHaveLength(0);
    });

    test("temporal edges form a chain in validFrom order regardless of insertion order", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        // insert out of chronological order
        g.addClaim(makeClaim("c2", "second", ["second"], [0, 0, 0], 5));
        g.addClaim(makeClaim("c1", "first", ["first"], [0, 0, 0], 1));
        g.addClaim(makeClaim("c3", "third", ["third"], [0, 0, 0], 10));
        // chain should be c1 — c2 — c3
        const c1Edges = g.neighbors("c1", ["temporal"]).map((e) => e.to);
        const c2Edges = g
            .neighbors("c2", ["temporal"])
            .map((e) => e.to)
            .sort();
        const c3Edges = g.neighbors("c3", ["temporal"]).map((e) => e.to);
        expect(c1Edges).toEqual(["c2"]);
        expect(c2Edges).toEqual(["c1", "c3"]);
        expect(c3Edges).toEqual(["c2"]);
    });

    test("inserting a claim into the middle of the chain rewires temporal edges", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        g.addClaim(makeClaim("a", "a", ["a"], [0, 0, 0], 1));
        g.addClaim(makeClaim("c", "c", ["c"], [0, 0, 0], 10));
        // Now insert b between them
        g.addClaim(makeClaim("b", "b", ["b"], [0, 0, 0], 5));
        // a — b — c, no a — c direct edge
        expect(g.neighbors("a", ["temporal"]).map((e) => e.to)).toEqual(["b"]);
        expect(
            g
                .neighbors("b", ["temporal"])
                .map((e) => e.to)
                .sort(),
        ).toEqual(["a", "c"]);
        expect(g.neighbors("c", ["temporal"]).map((e) => e.to)).toEqual(["b"]);
    });

    test("temporal edge meta carries deltaT", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        g.addClaim(makeClaim("a", "a", ["a"], [0, 0, 0], 1));
        g.addClaim(makeClaim("b", "b", ["b"], [0, 0, 0], 7));
        const e = g.neighbors("a", ["temporal"])[0];
        expect(e.meta?.deltaT).toBe(6);
    });

    test("neighbors with no type filter returns all edges", () => {
        const g = new GraphIndex({ semanticThreshold: 0.5 });
        g.addClaim(makeClaim("c1", "alex", ["alex"], [1, 0, 0], 1));
        g.addClaim(makeClaim("c2", "alex again", ["alex", "again"], [1, 0, 0], 2));
        // expect: temporal + lexical + semantic
        const all = g.neighbors("c1");
        const types = new Set(all.map((e) => e.type));
        expect(types).toEqual(new Set(["temporal", "lexical", "semantic"]));
    });

    test("rejects re-adding the same claim id", () => {
        const g = new GraphIndex();
        const c = makeClaim("c1", "x", ["x"], [1], 1);
        g.addClaim(c);
        expect(() => g.addClaim(c)).toThrow(/already in graph/);
    });
});
