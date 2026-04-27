import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { MemoryEngine } from "../../../src/core/engine.js";
import { MockLLMAdapter } from "../../helpers.js";
import { domainsCommand, domainCommand } from "../../../src/cli/commands/domains.js";
import type { DomainConfig, OwnedMemory, DomainContext } from "../../../src/core/types.js";
import type { ParsedCommand } from "../../../src/cli/types.js";

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures", "test-domain");

function makeParsed(command: string, args: string[] = []): ParsedCommand {
    return {
        command,
        args,
        flags: {},
    };
}

const testDomain: DomainConfig = {
    id: "test-domain",
    name: "Test Domain",
    baseDir: FIXTURES_DIR,
    skills: [
        {
            id: "consumption",
            name: "How to use Test Domain data",
            description: "Tells external agents how to query and interpret test domain data",
            scope: "external",
        },
        {
            id: "ingestion",
            name: "How to create Test Domain data",
            description: "Tells external agents how to create data for this domain",
            scope: "external",
        },
        {
            id: "analyze",
            name: "Internal analysis",
            description: "Used by domain agent to analyze test results",
            scope: "internal",
        },
    ],
    async processInboxBatch(_entries: OwnedMemory[], _context: DomainContext) {
        // no-op
    },
};

const minimalDomain: DomainConfig = {
    id: "minimal",
    name: "Minimal Domain",
    async processInboxBatch(_entries: OwnedMemory[], _context: DomainContext) {
        // no-op
    },
};

describe("domainsCommand", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(testDomain);
        await engine.registerDomain(minimalDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    it("returns list of all registered domains", async () => {
        const result = await domainsCommand(engine, makeParsed("domains"));
        expect(result.exitCode).toBe(0);
        const summaries = result.output as { id: string }[];
        expect(Array.isArray(summaries)).toBe(true);
        const ids = summaries.map((s) => s.id);
        expect(ids).toContain("test-domain");
        expect(ids).toContain("minimal");
    });

    it("does not set formatCommand (defaults to command name)", async () => {
        const result = await domainsCommand(engine, makeParsed("domains"));
        expect(result.formatCommand).toBeUndefined();
    });
});

describe("domainCommand - structure subcommand", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(testDomain);
        await engine.registerDomain(minimalDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    it("returns domain structure with formatCommand domain-structure", async () => {
        const result = await domainCommand(
            engine,
            makeParsed("domain", ["test-domain", "structure"]),
        );
        expect(result.exitCode).toBe(0);
        expect(result.formatCommand).toBe("domain-structure");
        const output = result.output as { domainId: string; structure: string };
        expect(output.domainId).toBe("test-domain");
        expect(output.structure).toContain("## Tags");
    });

    it("returns error when domain has no structure", async () => {
        const result = await domainCommand(engine, makeParsed("domain", ["minimal", "structure"]));
        expect(result.exitCode).toBe(1);
        const output = result.output as { error: string };
        expect(output.error).toContain("no structure");
    });
});

describe("domainCommand - skills subcommand", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(testDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    it("returns external skills with formatCommand domain-skills", async () => {
        const result = await domainCommand(engine, makeParsed("domain", ["test-domain", "skills"]));
        expect(result.exitCode).toBe(0);
        expect(result.formatCommand).toBe("domain-skills");
        const output = result.output as { domainId: string; skills: { id: string }[] };
        expect(output.domainId).toBe("test-domain");
        expect(Array.isArray(output.skills)).toBe(true);
        const ids = output.skills.map((s) => s.id);
        expect(ids).toContain("consumption");
        expect(ids).toContain("ingestion");
        expect(ids).not.toContain("analyze");
    });
});

describe("domainCommand - skill subcommand", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(testDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    it("returns specific skill with formatCommand domain-skill", async () => {
        const result = await domainCommand(
            engine,
            makeParsed("domain", ["test-domain", "skill", "consumption"]),
        );
        expect(result.exitCode).toBe(0);
        expect(result.formatCommand).toBe("domain-skill");
        const skill = result.output as { id: string; name: string; content: string };
        expect(skill.id).toBe("consumption");
        expect(skill.name).toBe("How to use Test Domain data");
        expect(skill.content).toContain("test/category");
    });

    it("returns error when skill is not found", async () => {
        const result = await domainCommand(
            engine,
            makeParsed("domain", ["test-domain", "skill", "nonexistent"]),
        );
        expect(result.exitCode).toBe(1);
        const output = result.output as { error: string };
        expect(output.error).toContain("nonexistent");
    });
});

describe("domainCommand - error cases", () => {
    let engine: MemoryEngine;

    beforeEach(async () => {
        engine = new MemoryEngine();
        await engine.initialize({
            connection: "mem://",
            namespace: "test",
            database: `test_${Date.now()}`,
            llm: new MockLLMAdapter(),
        });
        await engine.registerDomain(testDomain);
    });

    afterEach(async () => {
        await engine.close();
    });

    it("returns error when domain ID is missing", async () => {
        const result = await domainCommand(engine, makeParsed("domain", []));
        expect(result.exitCode).toBe(1);
        const output = result.output as { error: string };
        expect(output.error).toContain("Domain ID is required");
    });

    it("returns error when domain does not exist", async () => {
        const result = await domainCommand(
            engine,
            makeParsed("domain", ["unknown-domain", "structure"]),
        );
        expect(result.exitCode).toBe(1);
        const output = result.output as { error: string };
        expect(output.error).toContain("unknown-domain");
    });

    it("returns error when no subcommand is given", async () => {
        const result = await domainCommand(engine, makeParsed("domain", ["test-domain"]));
        expect(result.exitCode).toBe(1);
        const output = result.output as { error: string };
        expect(output.error).toContain("Subcommand is required");
    });

    it("returns error for unknown subcommand", async () => {
        const result = await domainCommand(
            engine,
            makeParsed("domain", ["test-domain", "unknown"]),
        );
        expect(result.exitCode).toBe(1);
        const output = result.output as { error: string };
        expect(output.error).toContain("unknown");
    });
});
