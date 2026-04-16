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

    test("lexical edges form between claims sharing tokens, weighted by IDF-jaccard", () => {
        const g = new GraphIndex({ semanticThreshold: 99 }); // disable semantic
        g.addClaim(makeClaim("c1", "alex moves to la", ["alex", "moves", "la"], [1, 0, 0], 1));
        g.addClaim(
            makeClaim("c2", "alex works at google", ["alex", "works", "google"], [0, 1, 0], 2),
        );
        const edges = g.neighbors("c1", ["lexical"]);
        expect(edges).toHaveLength(1);
        expect(edges[0].to).toBe("c2");
        // docCount=2; df(alex)=2 (in both), df(moves,la,works,google)=1 each
        // idf(alex) = ln((2+1)/(2+1))+1 = 1
        // idf(others) = ln((2+1)/(1+1))+1 = ln(1.5)+1 ≈ 1.4055
        // sharedIdf = 1; unionIdf = 1 + 4*1.4055 = 6.622
        // weight ≈ 1/6.622 ≈ 0.151
        expect(edges[0].weight).toBeCloseTo(0.151, 2);
        expect(edges[0].meta?.sharedTokens).toEqual(["alex"]);
        expect(edges[0].meta?.unionTokens?.length).toBe(5);
    });

    test("ubiquitous-token lexical edges have lower weight than rare-token edges", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        // ubiquitous: every claim mentions "alex"
        g.addClaim(makeClaim("a1", "alex moves", ["alex", "moves"], [1, 0, 0], 1));
        g.addClaim(makeClaim("a2", "alex jumps", ["alex", "jumps"], [0, 1, 0], 2));
        g.addClaim(makeClaim("a3", "alex runs", ["alex", "runs"], [0, 0, 1], 3));
        g.addClaim(makeClaim("a4", "alex reads", ["alex", "reads"], [1, 1, 0], 4));
        // rare: two claims that share a unique token "neurips"
        g.addClaim(
            makeClaim("b1", "alex spoke at neurips", ["alex", "spoke", "neurips"], [1, 0, 1], 5),
        );
        g.addClaim(
            makeClaim("b2", "alex wrote for neurips", ["alex", "wrote", "neurips"], [0, 1, 1], 6),
        );
        const aliceEdges = g.neighbors("a1", ["lexical"]);
        const a1a2 = aliceEdges.find((e) => e.to === "a2");
        const bobEdges = g.neighbors("b1", ["lexical"]);
        const b1b2 = bobEdges.find((e) => e.to === "b2");
        expect(a1a2).toBeDefined();
        expect(b1b2).toBeDefined();
        // rare-token edge (shares neurips + alex) should outweigh ubiquitous-only edge
        expect((b1b2 as { weight: number }).weight).toBeGreaterThan(
            (a1a2 as { weight: number }).weight,
        );
    });

    test("lexical weights are recomputed as new claims shift DF", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        g.addClaim(makeClaim("c1", "alex moves", ["alex", "moves"], [1, 0, 0], 1));
        g.addClaim(makeClaim("c2", "alex jumps", ["alex", "jumps"], [0, 1, 0], 2));
        const before = g.neighbors("c1", ["lexical"]).find((e) => e.to === "c2");
        expect(before).toBeDefined();
        const weightBefore = (before as { weight: number }).weight;
        // Add a third "alex" claim — df(alex) goes up, idf(alex) down, weight drops
        g.addClaim(makeClaim("c3", "alex runs", ["alex", "runs"], [0, 0, 1], 3));
        const after = g.neighbors("c1", ["lexical"]).find((e) => e.to === "c2");
        expect(after).toBeDefined();
        const weightAfter = (after as { weight: number }).weight;
        expect(weightAfter).toBeLessThan(weightBefore);
    });

    test("lexicalIdfFloor suppresses edges below the floor", () => {
        const g = new GraphIndex({ semanticThreshold: 99, lexicalIdfFloor: 0.2 });
        // Two claims sharing only "alex" — weight ≈ 0.151, below floor
        g.addClaim(makeClaim("c1", "alex moves to la", ["alex", "moves", "la"], [1, 0, 0], 1));
        g.addClaim(
            makeClaim("c2", "alex works at google", ["alex", "works", "google"], [0, 1, 0], 2),
        );
        expect(g.neighbors("c1", ["lexical"])).toHaveLength(0);
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

    test("temporal edges are uniform weight=1 when no decay tau is configured", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        g.addClaim(makeClaim("a", "a", ["a"], [0, 0, 0], 1));
        g.addClaim(makeClaim("b", "b", ["b"], [0, 0, 0], 4));
        g.addClaim(makeClaim("c", "c", ["c"], [0, 0, 0], 30));
        const ab = g.neighbors("a", ["temporal"])[0];
        const bc = g.neighbors("b", ["temporal"]).find((e) => e.to === "c");
        expect(ab.weight).toBe(1);
        expect(bc?.weight).toBe(1);
        expect(g.temporalDecayEnabled()).toBe(false);
    });

    test("temporalDecayTau yields weight = exp(-deltaT/tau) on temporal edges", () => {
        const tau = 5;
        const g = new GraphIndex({ semanticThreshold: 99, temporalDecayTau: tau });
        g.addClaim(makeClaim("a", "a", ["a"], [0, 0, 0], 1));
        g.addClaim(makeClaim("b", "b", ["b"], [0, 0, 0], 4)); // deltaT=3 → exp(-3/5)
        g.addClaim(makeClaim("c", "c", ["c"], [0, 0, 0], 30)); // deltaT=26 → exp(-26/5)
        expect(g.temporalDecayEnabled()).toBe(true);
        const ab = g.neighbors("a", ["temporal"])[0];
        const bc = g.neighbors("b", ["temporal"]).find((e) => e.to === "c");
        expect(ab.weight).toBeCloseTo(Math.exp(-3 / tau), 6);
        expect(bc?.weight).toBeCloseTo(Math.exp(-26 / tau), 6);
        expect(ab.weight).toBeGreaterThan(bc?.weight ?? Infinity);
    });

    test("middle insertion under decay rewires both edges with their own deltaT-based weights", () => {
        const tau = 4;
        const g = new GraphIndex({ semanticThreshold: 99, temporalDecayTau: tau });
        g.addClaim(makeClaim("a", "a", ["a"], [0, 0, 0], 1));
        g.addClaim(makeClaim("c", "c", ["c"], [0, 0, 0], 11));
        g.addClaim(makeClaim("b", "b", ["b"], [0, 0, 0], 5));
        const ab = g.neighbors("a", ["temporal"]).find((e) => e.to === "b");
        const bc = g.neighbors("b", ["temporal"]).find((e) => e.to === "c");
        const ac = g.neighbors("a", ["temporal"]).find((e) => e.to === "c");
        expect(ac).toBeUndefined();
        expect(ab?.weight).toBeCloseTo(Math.exp(-4 / tau), 6); // deltaT=4
        expect(bc?.weight).toBeCloseTo(Math.exp(-6 / tau), 6); // deltaT=6
    });

    test("nodeIdfMass aggregates idf over the claim's distinct tokens", () => {
        const g = new GraphIndex({ semanticThreshold: 99 });
        g.addClaim(makeClaim("a", "alex moves", ["alex", "moves"], [1, 0, 0], 1));
        g.addClaim(makeClaim("b", "alex jumps", ["alex", "jumps"], [0, 1, 0], 2));
        g.addClaim(makeClaim("c", "alex runs", ["alex", "runs"], [0, 0, 1], 3));
        g.addClaim(makeClaim("d", "neurips paper", ["neurips", "paper"], [1, 0, 1], 4));
        // 'alex' appears in 3/4 docs → low idf; 'neurips' and 'paper' in 1/4 → high idf.
        // d's tokens are both rare → larger nodeIdfMass than a's.
        const massA = g.nodeIdfMass("a");
        const massD = g.nodeIdfMass("d");
        expect(massD).toBeGreaterThan(massA);
        // sanity: equals manual sum
        expect(massA).toBeCloseTo(g.idf("alex") + g.idf("moves"), 6);
    });
});
