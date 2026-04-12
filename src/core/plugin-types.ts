import type {
    DomainConfig,
    DomainContext,
    DomainSchedule,
    DomainSchema,
    OwnedMemory,
    SearchQuery,
    ContextResult,
} from "./types.js";

interface DomainPluginHooks {
    /** Runs after domain.processInboxBatch completes */
    afterInboxProcess?(entries: OwnedMemory[], context: DomainContext): Promise<void>;
    /** Augments the search query before execution */
    expandSearch?(query: SearchQuery, context: DomainContext): Promise<SearchQuery>;
    /** Post-processes buildContext result */
    enrichContext?(
        result: ContextResult,
        text: string,
        context: DomainContext,
    ): Promise<ContextResult>;
    /** Runs during engine bootstrap for the host domain */
    bootstrap?(context: DomainContext): Promise<void>;
}

interface DomainPlugin {
    /** Plugin kind identifier, e.g. "topic-linking" */
    type: string;
    /** Schema contributions (edges/nodes the plugin owns) */
    schema?: DomainSchema;
    /** Schedules contributed to the host domain */
    schedules?: DomainSchedule[];
    /** Lifecycle hooks */
    hooks: DomainPluginHooks;
}

interface DomainRegistration {
    domain: DomainConfig;
    plugins?: DomainPlugin[];
    /** Plugin types that MUST be present — validated at startup */
    requires?: string[];
}

function isDomainRegistration(
    input: DomainConfig | DomainRegistration,
): input is DomainRegistration {
    return (
        "domain" in input && typeof (input as { domain?: { id?: unknown } }).domain?.id === "string"
    );
}

export type { DomainPlugin, DomainPluginHooks, DomainRegistration };
export { isDomainRegistration };
