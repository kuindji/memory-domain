import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionAdapter } from "../../core/types.js";
import type { DbConfig } from "../pg/types.js";

interface DirectoryAdapterConfig {
    /** Absolute path to a directory containing a pre-extracted `db/` subdirectory. */
    path: string;
}

/**
 * Opens an already-extracted PGLite database directory in place. Use when a
 * container image bakes an extracted DB or a dev loop builds it into a stable
 * location. `save()` is a no-op — pair with read-only deployments.
 */
class DirectoryConnectionAdapter implements ConnectionAdapter {
    constructor(private readonly config: DirectoryAdapterConfig) {}

    getLocalDir(): string {
        return this.config.path;
    }

    resolve(): Promise<DbConfig> {
        const dbPath = join(this.config.path, "db");
        if (!existsSync(dbPath)) {
            return Promise.reject(
                new Error(
                    `DirectoryConnectionAdapter: ${dbPath} does not exist. ` +
                        `Expected a pre-extracted PGLite database directory.`,
                ),
            );
        }
        return Promise.resolve({ kind: "pglite", dataDir: dbPath });
    }

    save(): Promise<void> {
        return Promise.resolve();
    }
}

export { DirectoryConnectionAdapter };
export type { DirectoryAdapterConfig };
