import { describe, test, expect } from "bun:test";
import {
    BunSqlQueryTimeoutError,
    runQueryWithWatchdog,
} from "../src/adapters/pg/bun-sql-adapter.js";

describe("runQueryWithWatchdog", () => {
    test("resolves when op settles before timeout", async () => {
        const rows = await runQueryWithWatchdog<{ id: number }>(
            "SELECT 1",
            async () => [{ id: 1 }],
            100,
            2,
            true,
        );
        expect(rows).toEqual([{ id: 1 }]);
    });

    test("retries on timeout and succeeds on a later attempt", async () => {
        let attempt = 0;
        const rows = await runQueryWithWatchdog<{ ok: boolean }>(
            "SELECT 1",
            () => {
                attempt += 1;
                if (attempt < 2) {
                    // Never settle on the first attempt — forces the watchdog.
                    return new Promise<unknown[]>(() => {});
                }
                return Promise.resolve([{ ok: true }]);
            },
            20,
            2,
            true,
        );
        expect(attempt).toBe(2);
        expect(rows).toEqual([{ ok: true }]);
    });

    test("throws BunSqlQueryTimeoutError after exhausting retries", async () => {
        let attempt = 0;
        const promise = runQueryWithWatchdog(
            "DELETE FROM tagged WHERE in_id = $1 AND out_id = $2",
            () => {
                attempt += 1;
                return new Promise<unknown[]>(() => {});
            },
            10,
            2,
            true,
        );
        await expect(promise).rejects.toBeInstanceOf(BunSqlQueryTimeoutError);
        expect(attempt).toBe(3);
    });

    test("does not retry inside a transaction (allowRetry=false)", async () => {
        let attempt = 0;
        const promise = runQueryWithWatchdog(
            "UPDATE memory SET structured_data = NULL WHERE id = $1",
            () => {
                attempt += 1;
                return new Promise<unknown[]>(() => {});
            },
            10,
            2,
            false,
        );
        await expect(promise).rejects.toBeInstanceOf(BunSqlQueryTimeoutError);
        expect(attempt).toBe(1);
    });

    test("propagates non-timeout errors without retry", async () => {
        let attempt = 0;
        const boom = new Error("syntax error at or near 'FROOM'");
        const promise = runQueryWithWatchdog(
            "SELECT FROOM thing",
            () => {
                attempt += 1;
                return Promise.reject(boom);
            },
            100,
            2,
            true,
        );
        await expect(promise).rejects.toBe(boom);
        expect(attempt).toBe(1);
    });

    test("disables watchdog when timeoutMs=0", async () => {
        const rows = await runQueryWithWatchdog<{ n: number }>(
            "SELECT 42",
            async () => [{ n: 42 }],
            0,
            2,
            true,
        );
        expect(rows).toEqual([{ n: 42 }]);
    });

    test("swallows unique_violation on retry (treats prior commit as success)", async () => {
        let attempt = 0;
        const rows = await runQueryWithWatchdog(
            "INSERT INTO mentions_person (id, in_id, out_id) VALUES ($1, $2, $3)",
            () => {
                attempt += 1;
                if (attempt === 1) {
                    return new Promise<unknown[]>(() => {});
                }
                const err = Object.assign(new Error("duplicate key value"), {
                    errno: "23505",
                });
                return Promise.reject(err);
            },
            10,
            2,
            true,
        );
        expect(attempt).toBe(2);
        expect(rows).toEqual([]);
    });

    test("does not swallow unique_violation on the first attempt", async () => {
        const err = Object.assign(new Error("duplicate key value"), { errno: "23505" });
        let attempt = 0;
        const promise = runQueryWithWatchdog(
            "INSERT INTO foo VALUES ($1)",
            () => {
                attempt += 1;
                return Promise.reject(err);
            },
            100,
            2,
            true,
        );
        await expect(promise).rejects.toBe(err);
        expect(attempt).toBe(1);
    });

    test("includes elapsedMs and SQL prefix in the timeout error", async () => {
        try {
            await runQueryWithWatchdog(
                "DELETE FROM meta WHERE id = $1 RETURNING id",
                () => new Promise<unknown[]>(() => {}),
                15,
                0,
                true,
            );
            throw new Error("expected timeout");
        } catch (err) {
            expect(err).toBeInstanceOf(BunSqlQueryTimeoutError);
            const e = err as BunSqlQueryTimeoutError;
            expect(e.sql).toBe("DELETE FROM meta WHERE id = $1 RETURNING id");
            expect(e.elapsedMs).toBeGreaterThanOrEqual(10);
        }
    });
});
