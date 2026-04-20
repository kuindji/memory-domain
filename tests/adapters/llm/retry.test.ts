import { describe, it, expect } from "bun:test";
import { runWithRetry } from "../../../src/adapters/llm/retry.js";

describe("runWithRetry", () => {
    it("returns the result on first success without delay", async () => {
        let calls = 0;
        const result = await runWithRetry(
            () => {
                calls++;
                return Promise.resolve("ok");
            },
            { isRetryable: () => true, label: "[test]" },
        );
        expect(result).toBe("ok");
        expect(calls).toBe(1);
    });

    it("retries retryable errors then succeeds", async () => {
        let calls = 0;
        const result = await runWithRetry(
            () => {
                calls++;
                if (calls < 3) return Promise.reject(new Error("retryable"));
                return Promise.resolve("done");
            },
            {
                isRetryable: () => true,
                label: "[test]",
                baseDelayMs: 1,
                maxRetries: 3,
            },
        );
        expect(result).toBe("done");
        expect(calls).toBe(3);
    });

    it("throws immediately when error is not retryable", async () => {
        let calls = 0;
        await expect(
            runWithRetry(
                () => {
                    calls++;
                    return Promise.reject(new Error("fatal"));
                },
                { isRetryable: () => false, label: "[test]", baseDelayMs: 1 },
            ),
        ).rejects.toThrow("fatal");
        expect(calls).toBe(1);
    });

    it("throws the last error after maxRetries retryable failures", async () => {
        let calls = 0;
        await expect(
            runWithRetry(
                () => {
                    calls++;
                    return Promise.reject(new Error(`attempt-${calls}`));
                },
                {
                    isRetryable: () => true,
                    label: "[test]",
                    baseDelayMs: 1,
                    maxRetries: 2,
                },
            ),
        ).rejects.toThrow("attempt-3");
        expect(calls).toBe(3);
    });
});
