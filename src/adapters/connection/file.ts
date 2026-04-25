import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import type { ConnectionAdapter } from "../../core/types.js";
import type { DbConfig } from "../pg/types.js";

interface FileAdapterConfig {
    /** Absolute path to the tar.gz archive on disk. */
    file: string;
    /** Where to extract to. Defaults to a hashed subdir of os.tmpdir(). */
    localDir?: string;
    /** When true, save() recompresses the db/ directory back to `file`. */
    save?: boolean;
}

class FileConnectionAdapter implements ConnectionAdapter {
    private readonly config: FileAdapterConfig;
    private readonly localDir: string;

    constructor(config: FileAdapterConfig) {
        this.config = config;
        this.localDir = config.localDir ?? this.deriveLocalDir();
    }

    getLocalDir(): string {
        return this.localDir;
    }

    async resolve(): Promise<DbConfig> {
        mkdirSync(this.localDir, { recursive: true });
        if (existsSync(this.config.file)) {
            const archive = readFileSync(this.config.file);
            const stream = Readable.from(archive);
            await pipeline(stream, createGunzip(), tar.extract({ cwd: this.localDir }));
        }
        return { kind: "pglite", dataDir: join(this.localDir, "db") };
    }

    async save(): Promise<void> {
        if (!this.config.save) return;
        mkdirSync(dirname(this.config.file), { recursive: true });
        const chunks: Uint8Array[] = [];
        const stream = tar.create({ gzip: true, cwd: this.localDir }, ["db"]);
        for await (const chunk of stream) {
            chunks.push(chunk as Uint8Array);
        }
        writeFileSync(this.config.file, Buffer.concat(chunks));
    }

    private deriveLocalDir(): string {
        const hash = createHash("sha256").update(this.config.file).digest("hex").slice(0, 12);
        return join(tmpdir(), `memory-domain-file-${hash}`);
    }
}

export { FileConnectionAdapter };
export type { FileAdapterConfig };
