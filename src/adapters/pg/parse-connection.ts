import type { DbConfig } from "./types.js";

/**
 * Parse a legacy connection string into a DbConfig. Supports the strings the
 * memory-domain CLI and existing Silentium scripts already pass:
 *
 *   `mem://`                       — in-memory PGLite
 *   `pglite://<path>`              — file-backed PGLite at <path>
 *   `surrealkv://<path>`           — file-backed PGLite at <path> (legacy alias;
 *                                    the data layout is incompatible with the
 *                                    pre-migration SurrealKV files — start clean)
 *   `postgres://...` / `postgresql://...` — managed Postgres via Bun.SQL
 */
export function parseConnectionString(connection: string): DbConfig {
    if (connection === "mem://" || connection === "memory" || connection === "memory://") {
        return { kind: "pglite" };
    }
    if (connection.startsWith("pglite://")) {
        return { kind: "pglite", dataDir: connection.slice("pglite://".length) };
    }
    if (connection.startsWith("surrealkv://")) {
        return { kind: "pglite", dataDir: connection.slice("surrealkv://".length) };
    }
    if (connection.startsWith("postgres://") || connection.startsWith("postgresql://")) {
        return { kind: "postgres", url: connection };
    }
    throw new Error(
        `Unrecognized connection string: "${connection}". ` +
            `Use 'mem://', 'pglite://<path>', or 'postgres://...'.`,
    );
}
