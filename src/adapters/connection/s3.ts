import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import * as tar from "tar";
import type { ConnectionAdapter, S3AdapterConfig } from "../../core/types.js";
import type { DbConfig } from "../pg/types.js";

type Downloader = () => Promise<Buffer | null>;
type Uploader = (data: Buffer) => Promise<void>;

class S3ConnectionAdapter implements ConnectionAdapter {
    private config: S3AdapterConfig;
    private localDir: string;
    private downloader: Downloader;
    private uploader: Uploader;

    constructor(config: S3AdapterConfig) {
        this.config = config;
        this.localDir = config.localDir ?? this.deriveLocalDir();

        const client = new S3Client({
            region: config.region,
            ...(config.credentials
                ? {
                      credentials: {
                          accessKeyId: config.credentials.accessKeyId,
                          secretAccessKey: config.credentials.secretAccessKey,
                      },
                  }
                : config.profile
                  ? { credentials: fromIni({ profile: config.profile }) }
                  : {}),
        });

        this.downloader = async () => {
            try {
                const response = await client.send(
                    new GetObjectCommand({
                        Bucket: config.bucket,
                        Key: config.key,
                    }),
                );
                if (!response.Body) return null;
                const chunks: Uint8Array[] = [];
                for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks);
            } catch (err: unknown) {
                const error = err as { name?: string };
                if (error.name === "NoSuchKey" || error.name === "NotFound") {
                    return null;
                }
                throw new Error(
                    `Failed to download s3://${config.bucket}/${config.key}: ${String(err)}`,
                    { cause: err },
                );
            }
        };

        this.uploader = async (data: Buffer) => {
            try {
                await client.send(
                    new PutObjectCommand({
                        Bucket: config.bucket,
                        Key: config.key,
                        Body: data,
                    }),
                );
            } catch (err: unknown) {
                throw new Error(
                    `Failed to upload to s3://${config.bucket}/${config.key}: ${String(err)}`,
                    { cause: err },
                );
            }
        };
    }

    getLocalDir(): string {
        return this.localDir;
    }

    async resolve(): Promise<DbConfig> {
        mkdirSync(this.localDir, { recursive: true });
        const archive = await this.downloader();
        if (archive) {
            await this.extract(archive);
        }
        return { kind: "pglite", dataDir: join(this.localDir, "db") };
    }

    async save(): Promise<void> {
        if (!this.config.save) return;

        const archive = await this.compress();
        await this.uploader(archive);
    }

    /** @internal — for testing only */
    _setDownloader(fn: Downloader): void {
        this.downloader = fn;
    }

    /** @internal — for testing only */
    _setUploader(fn: Uploader): void {
        this.uploader = fn;
    }

    private deriveLocalDir(): string {
        const hash = createHash("sha256")
            .update(`${this.config.bucket}/${this.config.key}`)
            .digest("hex")
            .slice(0, 12);
        return join(tmpdir(), `memory-domain-${hash}`);
    }

    private async extract(archive: Buffer): Promise<void> {
        const stream = Readable.from(archive);
        await pipeline(stream, createGunzip(), tar.extract({ cwd: this.localDir }));
    }

    private async compress(): Promise<Buffer> {
        const chunks: Uint8Array[] = [];
        const stream = tar.create({ gzip: true, cwd: this.localDir }, ["db"]);
        for await (const chunk of stream) {
            chunks.push(chunk as Uint8Array);
        }
        return Buffer.concat(chunks);
    }
}

export { S3ConnectionAdapter };
