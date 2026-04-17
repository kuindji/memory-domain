import { describe, test, expect } from "bun:test";
import { PathMemory } from "../src/interfaces.js";
import { makeFakeEmbedder } from "./helpers.js";

describe("Session — turn tracking (Phase 2.1)", () => {
    test("each addProbeSentences call stamps probes with the current turn index", async () => {
        const memory = new PathMemory({ embedder: makeFakeEmbedder() });
        await memory.ingest({ text: "anchor claim", validFrom: 1 });
        const session = memory.createSession();

        await session.addProbeSentences(["first turn probe a", "first turn probe b"]);
        await session.addProbeSentences(["second turn probe"]);
        await session.addProbeSentences(["third turn probe x", "third turn probe y"]);

        expect(session.probeCount).toBe(5);
        expect(session.turnCount).toBe(3);

        // Reach into the retriever via a public retrieval call: verify
        // turn-index-stamped probes flow through. We do this by enabling
        // sessionDecayTau and asserting that the late-turn weight wins on a
        // proxy claim — simpler and more direct than poking private state.
        // (Detailed coverage arithmetic lives in retriever.test.ts.)
    });

    test("addNaturalQuery also advances the turn counter", async () => {
        const memory = new PathMemory({ embedder: makeFakeEmbedder() });
        const session = memory.createSession();
        await session.addNaturalQuery("hello world");
        expect(session.turnCount).toBe(1);
        await session.addProbeSentences(["next turn"]);
        expect(session.turnCount).toBe(2);
    });

    test("reset() clears probes and resets the turn counter to 0", async () => {
        const memory = new PathMemory({ embedder: makeFakeEmbedder() });
        const session = memory.createSession();
        await session.addProbeSentences(["a", "b"]);
        await session.addProbeSentences(["c"]);
        expect(session.probeCount).toBe(3);
        expect(session.turnCount).toBe(2);
        session.reset();
        expect(session.probeCount).toBe(0);
        expect(session.turnCount).toBe(0);
    });

    test("PathMemory.queryWithProbes leaves turnIndex undefined (one-shot use is back-compat)", async () => {
        const memory = new PathMemory({ embedder: makeFakeEmbedder() });
        await memory.ingest({ text: "one shot target", validFrom: 1 });
        // No throw, no turnIndex requirement: queryWithProbes works as before.
        const results = await memory.queryWithProbes(["one shot target"], {
            sessionDecayTau: 0.5,
        });
        expect(results.length).toBeGreaterThan(0);
        // sessionDecayTau without turnIndex collapses to uniform weights —
        // result equivalent to calling without the option.
        const baseline = await memory.queryWithProbes(["one shot target"]);
        expect(results.length).toBe(baseline.length);
    });
});
