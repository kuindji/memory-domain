import type { ConnectionAdapter } from "../../core/types.ts";

class PassthroughAdapter implements ConnectionAdapter {
    private connection: string;

    constructor(connection: string) {
        this.connection = connection;
    }

    resolve(): Promise<string> {
        return Promise.resolve(this.connection);
    }

    save(): Promise<void> {
        return Promise.resolve();
    }
}

export { PassthroughAdapter };
