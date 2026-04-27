import type { ConnectionAdapter } from "../../core/types.js";
import type { DbConfig } from "../pg/types.js";

class PassthroughAdapter implements ConnectionAdapter {
    constructor(private dbConfig: DbConfig) {}

    resolve(): Promise<DbConfig> {
        return Promise.resolve(this.dbConfig);
    }

    save(): Promise<void> {
        return Promise.resolve();
    }
}

export { PassthroughAdapter };
