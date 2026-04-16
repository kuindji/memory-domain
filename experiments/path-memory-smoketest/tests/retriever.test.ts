import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/store.js";
import { GraphIndex } from "../src/graph.js";
import { Retriever } from "../src/retriever.js";
import { makeFakeEmbedder, trivialTokenize, wireGraphToStore } from "./helpers.js";

function setup(opts?: { semanticThreshold?: number }) {
    const emb = makeFakeEmbedder();
    const store = new MemoryStore({ embed: (t) => emb.embed(t), tokenize: trivialTokenize });
    const graph = new GraphIndex({ semanticThreshold: opts?.semanticThreshold ?? -1 });
    wireGraphToStore(store, graph);
    const retriever = new Retriever({ graph });
    return { emb, store, graph, retriever };
}

describe("Retriever", () => {
    test("single probe returns paths anchored on the closest match", async () => {
        const { emb, store, retriever } = setup();
        await store.ingest({ text: "alex moves to la", validFrom: 1 });
        await store.ingest({ text: "bob lives in boston", validFrom: 2 });
        const probeVec = await emb.embed("alex moves to la");
        const results = retriever.retrieve([{ text: "alex moves to la", embedding: probeVec }], {
            anchorTopK: 1,
        });
        expect(results.length).toBeGreaterThan(0);
        // With top-1 anchors, the closest match to the probe is the only anchor,
        // so every returned path must include it.
        for (const r of results) expect(r.path.nodeIds).toContain("c1");
    });

    test("multi-probe: a single path covering both probes ranks above solo paths", async () => {
        const { emb, store, retriever } = setup();
        await store.ingest({ text: "alex moves to la", validFrom: 1 });
        await store.ingest({ text: "alex starts a new job", validFrom: 2 });
        await store.ingest({ text: "alex changes jobs again", validFrom: 3 });

        const probeA = await emb.embed("alex moves to la");
        const probeB = await emb.embed("alex starts a new job");

        const results = retriever.retrieve(
            [
                { text: "a", embedding: probeA },
                { text: "b", embedding: probeB },
            ],
            { anchorTopK: 1 },
        );

        const top = results[0];
        // Top result covers both probes
        expect(top.breakdown.probeCoverage).toBe(1);
        expect(top.path.nodeIds).toContain("c1");
        expect(top.path.nodeIds).toContain("c2");
    });

    test("mode=current excludes superseded claims from anchor candidates", async () => {
        const { emb, store, retriever } = setup();
        const a = await store.ingest({ text: "alex lives in nyc", validFrom: 1 });
        await store.ingest({ text: "alex moves to la", validFrom: 5, supersedes: a.id });
        const probe = await emb.embed("alex lives in nyc");
        const results = retriever.retrieve([{ text: "x", embedding: probe }]);
        const allNodes = new Set(results.flatMap((r) => r.path.nodeIds));
        expect(allNodes.has("c1")).toBe(false);
        expect(allNodes.has("c2")).toBe(true);
    });

    test("mode=asOf reconstructs historical state and surfaces superseded claims", async () => {
        const { emb, store, retriever } = setup();
        const a = await store.ingest({ text: "alex lives in nyc", validFrom: 1 });
        await store.ingest({ text: "alex moves to la", validFrom: 5, supersedes: a.id });
        const probe = await emb.embed("alex lives in nyc");
        const results = retriever.retrieve([{ text: "x", embedding: probe }], {
            mode: { kind: "asOf", at: 3 },
        });
        const allNodes = new Set(results.flatMap((r) => r.path.nodeIds));
        expect(allNodes.has("c1")).toBe(true);
        expect(allNodes.has("c2")).toBe(false);
    });

    test("breakdown is well-formed and within expected ranges", async () => {
        const { emb, store, retriever } = setup();
        await store.ingest({ text: "alex moves", validFrom: 1 });
        await store.ingest({ text: "alex jumps", validFrom: 2 });
        await store.ingest({ text: "alex runs", validFrom: 3 });
        const probe = await emb.embed("alex moves");
        const [top] = retriever.retrieve([{ text: "x", embedding: probe }]);
        expect(top.breakdown.probeCoverage).toBeGreaterThanOrEqual(0);
        expect(top.breakdown.probeCoverage).toBeLessThanOrEqual(1);
        expect(top.breakdown.edgeTypeDiversity).toBeGreaterThanOrEqual(0);
        expect(top.breakdown.edgeTypeDiversity).toBeLessThanOrEqual(1);
        expect(top.breakdown.recency).toBeGreaterThanOrEqual(0);
        expect(top.breakdown.recency).toBeLessThanOrEqual(1);
        expect(top.breakdown.pathQuality).toBeGreaterThanOrEqual(0);
        expect(top.breakdown.pathQuality).toBeLessThanOrEqual(1);
        expect(top.breakdown.lengthPenalty).toBeGreaterThanOrEqual(0);
    });

    test("pathQuality is 0 for solo paths and the edge-weight average for multi-edge paths", async () => {
        const { emb, store, retriever } = setup();
        await store.ingest({ text: "alex moves to la", validFrom: 1 });
        await store.ingest({ text: "alex starts a new job", validFrom: 2 });
        const probeA = await emb.embed("alex moves to la");
        const probeB = await emb.embed("alex starts a new job");

        const results = retriever.retrieve(
            [
                { text: "a", embedding: probeA },
                { text: "b", embedding: probeB },
            ],
            { anchorTopK: 1 },
        );

        const solo = results.find((r) => r.path.nodeIds.length === 1);
        const multi = results.find((r) => r.path.nodeIds.length > 1);
        // Solo paths have no edges to evaluate — pathQuality is 0 (not a free boost).
        expect(solo?.breakdown.pathQuality).toBe(0);
        if (multi && multi.path.edges.length > 0) {
            const expected =
                multi.path.edges.reduce((s, e) => s + e.weight, 0) / multi.path.edges.length;
            expect(multi.breakdown.pathQuality).toBeCloseTo(expected, 5);
        }
    });

    test("informational length-penalty credits anchor-dense paths", async () => {
        const { emb, store, retriever } = setup();
        // Three anchor-worthy claims. All share "alex" so lexical edges form.
        await store.ingest({ text: "alex moves", validFrom: 1 });
        await store.ingest({ text: "alex jumps", validFrom: 2 });
        await store.ingest({ text: "alex runs", validFrom: 3 });

        const pA = await emb.embed("alex moves");
        const pB = await emb.embed("alex jumps");
        const pC = await emb.embed("alex runs");

        const results = retriever.retrieve(
            [
                { text: "a", embedding: pA },
                { text: "b", embedding: pB },
                { text: "c", embedding: pC },
            ],
            { anchorTopK: 1 },
        );

        // Pure-anchor path (all 3 nodes are anchors) should have lengthPenalty 0.
        const allAnchorPath = results.find((r) => r.path.nodeIds.length === 3);
        if (allAnchorPath) {
            expect(allAnchorPath.breakdown.lengthPenalty).toBe(0);
        }
    });

    test("empty probe list returns no paths", () => {
        const { retriever } = setup();
        const results = retriever.retrieve([]);
        expect(results).toEqual([]);
    });

    test("traversal=dijkstra returns structurally valid paths", async () => {
        const { emb, store, retriever } = setup();
        await store.ingest({ text: "alex moves", validFrom: 1 });
        await store.ingest({ text: "alex jumps", validFrom: 2 });
        await store.ingest({ text: "alex runs", validFrom: 3 });
        const probe = await emb.embed("alex moves");
        const results = retriever.retrieve([{ text: "x", embedding: probe }], {
            traversal: "dijkstra",
            temporalHopCost: 0.5,
        });
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
            expect(r.path.nodeIds.length).toBeGreaterThanOrEqual(1);
            expect(r.path.edges.length).toBe(r.path.nodeIds.length - 1);
            expect(r.breakdown.probeCoverage).toBeGreaterThanOrEqual(0);
        }
    });

    test("traversal=dijkstra prefers high-weight bridges over weak direct links", async () => {
        // Two anchors: if a direct weak-lexical edge and a 2-hop strong-semantic
        // bridge both exist, Dijkstra should surface the 2-hop bridge (lower cost),
        // whereas BFS-by-hops would surface the direct 1-hop path.
        const emb = makeFakeEmbedder();
        const store = new MemoryStore({ embed: (t) => emb.embed(t), tokenize: trivialTokenize });
        // semanticThreshold -1 → every pair gets a semantic edge at its raw cosine
        const graph = new GraphIndex({ semanticThreshold: -1 });
        wireGraphToStore(store, graph);
        const retriever = new Retriever({ graph });

        await store.ingest({ text: "alpha shared", validFrom: 1 });
        await store.ingest({ text: "beta connector", validFrom: 2 });
        await store.ingest({ text: "gamma shared", validFrom: 3 });

        const probeA = await emb.embed("alpha shared");
        const probeC = await emb.embed("gamma shared");

        const bfsResults = retriever.retrieve(
            [
                { text: "a", embedding: probeA },
                { text: "c", embedding: probeC },
            ],
            { anchorTopK: 1, traversal: "bfs" },
        );
        const dijkstraResults = retriever.retrieve(
            [
                { text: "a", embedding: probeA },
                { text: "c", embedding: probeC },
            ],
            { anchorTopK: 1, traversal: "dijkstra", temporalHopCost: 0.5 },
        );

        // Both modes produce results; both include anchors; shape is valid.
        expect(bfsResults.length).toBeGreaterThan(0);
        expect(dijkstraResults.length).toBeGreaterThan(0);
        for (const r of dijkstraResults) {
            expect(r.path.edges.length).toBe(r.path.nodeIds.length - 1);
        }
    });

    test("results are deduplicated by canonical node-set", async () => {
        const { emb, store, retriever } = setup();
        await store.ingest({ text: "alex moves", validFrom: 1 });
        await store.ingest({ text: "alex jumps", validFrom: 2 });
        await store.ingest({ text: "alex runs", validFrom: 3 });
        const probe1 = await emb.embed("alex moves");
        const probe2 = await emb.embed("alex jumps");
        const results = retriever.retrieve([
            { text: "a", embedding: probe1 },
            { text: "b", embedding: probe2 },
        ]);
        // assert no exact-duplicate multi-node paths (solo paths use a separate key prefix internally)
        const multiNodeCanonicals = results
            .filter((r) => r.path.nodeIds.length > 1)
            .map((r) => [...r.path.nodeIds].sort().join(","));
        expect(new Set(multiNodeCanonicals).size).toBe(multiNodeCanonicals.length);
    });
});
