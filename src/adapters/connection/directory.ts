import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionAdapter } from "../../core/types.js";

interface DirectoryAdapterConfig {
    /** Absolute path to a directory containing a pre-extracted `db/` subdirectory. */
    path: string;
}

/**
 * Opens an already-extracted SurrealKV database directory in place.
 *
 * Use when a container image bakes an extracted KB or a dev loop builds
 * the DB into a stable location, avoiding the tar extraction cost of
 * FileConnectionAdapter.
 *
 * Read-intended: pair with the Lambda read-only profile. `save()` is a
 * no-op. Do not open the same path twice in one process — SurrealKV
 * expects exclusive access per directory.
 */
class DirectoryConnectionAdapter implements ConnectionAdapter {
    constructor(private readonly config: DirectoryAdapterConfig) {}

    getLocalDir(): string {
        return this.config.path;
    }

    resolve(): Promise<string> {
        const dbPath = join(this.config.path, "db");
        if (!existsSync(dbPath)) {
            return Promise.reject(
                new Error(
                    `DirectoryConnectionAdapter: ${dbPath} does not exist. ` +
                        `Expected a pre-extracted SurrealKV database directory.`,
                ),
            );
        }
        return Promise.resolve(`surrealkv://${dbPath}`);
    }

    save(): Promise<void> {
        // no-op — read-intended adapter
        return Promise.resolve();
    }
}

export { DirectoryConnectionAdapter };
export type { DirectoryAdapterConfig };
