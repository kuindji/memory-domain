export interface RetryOptions {
    maxRetries?: number;
    baseDelayMs?: number;
    isRetryable: (err: unknown) => boolean;
    label: string;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 30_000;

export async function runWithRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.log(`${opts.label} Retry ${attempt}/${maxRetries} after ${delay / 1000}s...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!opts.isRetryable(err) || attempt === maxRetries) {
                throw err;
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(`${opts.label} failed after retries`);
}
