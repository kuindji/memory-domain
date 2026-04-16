import { describe, test, expect } from "bun:test";
import { MemoryStore } from "../src/store.js";
import { makeFakeEmbedder, trivialTokenize } from "./helpers.js";

function makeStore() {
    const emb = makeFakeEmbedder();
    return new MemoryStore({
        embed: (t) => emb.embed(t),
        tokenize: trivialTokenize,
    });
}

describe("MemoryStore", () => {
    test("ingest creates a current claim with embedding + tokens", async () => {
        const s = makeStore();
        const c = await s.ingest({ text: "Alex lives in NYC", validFrom: 1 });
        expect(c.id).toBe("c1");
        expect(c.validFrom).toBe(1);
        expect(c.validUntil).toBe(Number.POSITIVE_INFINITY);
        expect(c.embedding.length).toBe(384);
        expect(c.tokens).toContain("alex");
        expect(c.tokens).toContain("nyc");
        expect(s.currentClaims()).toHaveLength(1);
    });

    test("supersession marks the old claim's validUntil and removes it from current", async () => {
        const s = makeStore();
        const old = await s.ingest({ text: "Alex lives in NYC", validFrom: 1 });
        const fresh = await s.ingest({
            text: "Alex moves to LA",
            validFrom: 5,
            supersedes: old.id,
        });
        expect(s.getById(old.id)?.validUntil).toBe(5);
        expect(s.currentClaims().map((c) => c.id)).toEqual([fresh.id]);
        expect(s.allClaims()).toHaveLength(2);
    });

    test("claimsAt(t) reconstructs the state of the world at time t", async () => {
        const s = makeStore();
        const a = await s.ingest({ text: "Alex lives in NYC", validFrom: 1 });
        await s.ingest({ text: "Alex moves to LA", validFrom: 5, supersedes: a.id });
        const at0 = s.claimsAt(0).map((c) => c.text);
        const at3 = s.claimsAt(3).map((c) => c.text);
        const at5 = s.claimsAt(5).map((c) => c.text);
        const at10 = s.claimsAt(10).map((c) => c.text);
        expect(at0).toEqual([]);
        expect(at3).toEqual(["Alex lives in NYC"]);
        expect(at5).toEqual(["Alex moves to LA"]);
        expect(at10).toEqual(["Alex moves to LA"]);
    });

    test("history log records ingest + supersede events in order", async () => {
        const s = makeStore();
        const a = await s.ingest({ text: "first", validFrom: 1 });
        await s.ingest({ text: "second", validFrom: 2, supersedes: a.id });
        const log = s.historyLog;
        expect(log.length).toBe(3);
        expect(log[0].kind).toBe("ingest");
        expect(log[1].kind).toBe("ingest");
        expect(log[2].kind).toBe("supersede");
    });

    test("rejects supersession of unknown claim", async () => {
        const s = makeStore();
        let err: Error | undefined;
        try {
            await s.ingest({ text: "x", validFrom: 1, supersedes: "nonexistent" });
        } catch (e) {
            err = e as Error;
        }
        expect(err?.message).toMatch(/unknown claim/);
    });

    test("rejects supersession of an already-invalidated claim", async () => {
        const s = makeStore();
        const a = await s.ingest({ text: "first", validFrom: 1 });
        await s.ingest({ text: "second", validFrom: 5, supersedes: a.id });
        let err: Error | undefined;
        try {
            await s.ingest({ text: "third", validFrom: 10, supersedes: a.id });
        } catch (e) {
            err = e as Error;
        }
        expect(err?.message).toMatch(/already invalid/);
    });

    test("subscribe receives ingest and supersede events", async () => {
        const s = makeStore();
        const events: string[] = [];
        s.subscribe((e) => events.push(e.kind));
        const a = await s.ingest({ text: "first", validFrom: 1 });
        await s.ingest({ text: "second", validFrom: 2, supersedes: a.id });
        expect(events).toEqual(["ingested", "superseded", "ingested"]);
    });
});
