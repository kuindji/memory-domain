import { describe, it, expect } from "bun:test";
import { formatOutput, formatError } from "../../src/cli/format.js";
import type {
    DomainSummary,
    DomainSkill,
    IngestResult,
    SearchResult,
    AskResult,
    ContextResult,
    ScoredMemory,
} from "../../src/core/types.js";

const makeScoredMemory = (overrides: Partial<ScoredMemory> = {}): ScoredMemory => ({
    id: "mem1",
    content: "Sample memory content",
    score: 0.85,
    scores: { vector: 0.85 },
    tags: ["tag1", "tag2"],
    domainAttributes: {},
    eventTime: null,
    createdAt: 1000000,
    ...overrides,
});

describe("formatOutput - JSON envelope mode (pretty=false)", () => {
    it("wraps domains data in ok envelope", () => {
        const data: DomainSummary[] = [
            { id: "dom1", name: "Domain One", hasStructure: true, skillCount: 3 },
        ];
        const result = formatOutput("domains", data, false);
        const parsed = JSON.parse(result) as { ok: boolean; data: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toEqual(data);
    });

    it("wraps ingest data in ok envelope", () => {
        const data: IngestResult = { action: "stored", id: "abc123" };
        const result = formatOutput("ingest", data, false);
        const parsed = JSON.parse(result) as { ok: boolean; data: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toEqual(data);
    });

    it("wraps search data in ok envelope", () => {
        const data: SearchResult = {
            entries: [makeScoredMemory()],
            totalTokens: 100,
            mode: "hybrid",
        };
        const result = formatOutput("search", data, false);
        const parsed = JSON.parse(result) as { ok: boolean; data: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toEqual(data);
    });

    it("wraps ask data in ok envelope", () => {
        const data: AskResult = {
            answer: "The answer",
            memories: [makeScoredMemory()],
            rounds: 2,
        };
        const result = formatOutput("ask", data, false);
        const parsed = JSON.parse(result) as { ok: boolean; data: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toEqual(data);
    });

    it("wraps build-context data in ok envelope", () => {
        const data: ContextResult = {
            context: "The context text",
            memories: [makeScoredMemory()],
            totalTokens: 512,
        };
        const result = formatOutput("build-context", data, false);
        const parsed = JSON.parse(result) as { ok: boolean; data: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toEqual(data);
    });

    it("wraps unknown command data in ok envelope", () => {
        const data = { foo: "bar" };
        const result = formatOutput("unknown-command", data, false);
        const parsed = JSON.parse(result) as { ok: boolean; data: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toEqual(data);
    });
});

describe("formatError", () => {
    it("returns ok:false envelope with code and message", () => {
        const result = formatError("CONFIG_ERROR", "Config file not found");
        const parsed = JSON.parse(result) as {
            ok: boolean;
            error: { code: string; message: string };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("CONFIG_ERROR");
        expect(parsed.error.message).toBe("Config file not found");
    });

    it("returns valid JSON for any code and message", () => {
        const result = formatError("UNKNOWN", "Something went wrong");
        const parsed = JSON.parse(result) as {
            ok: boolean;
            error: { code: string; message: string };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("UNKNOWN");
        expect(parsed.error.message).toBe("Something went wrong");
    });
});

describe("formatOutput - pretty mode: domains", () => {
    it("formats domains with description, skills, and structure", () => {
        const data: DomainSummary[] = [
            {
                id: "domain-id",
                name: "Domain Name",
                description: "Description text",
                hasStructure: true,
                skillCount: 3,
            },
            { id: "other-id", name: "Other Name", hasStructure: false, skillCount: 0 },
        ];
        const result = formatOutput("domains", data, true);
        const lines = result.split("\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("domain-id");
        expect(lines[0]).toContain("Domain Name");
        expect(lines[0]).toContain("Description text");
        expect(lines[0]).toContain("3 skills");
        expect(lines[0]).toContain("has structure");
        expect(lines[1]).toContain("other-id");
        expect(lines[1]).toContain("Other Name");
        expect(lines[1]).toContain("No description");
        expect(lines[1]).not.toContain("skills");
        expect(lines[1]).not.toContain("has structure");
    });

    it('shows singular "skill" for skillCount of 1', () => {
        const data: DomainSummary[] = [
            { id: "dom1", name: "Domain", hasStructure: false, skillCount: 1 },
        ];
        const result = formatOutput("domains", data, true);
        expect(result).toContain("1 skill");
        expect(result).not.toContain("1 skills");
    });

    it("returns empty string for empty domains list", () => {
        const result = formatOutput("domains", [], true);
        expect(result).toBe("");
    });

    it("pads ids to the longest", () => {
        const data: DomainSummary[] = [
            { id: "a", name: "Short", hasStructure: false, skillCount: 0 },
            { id: "longer-id", name: "Long", hasStructure: false, skillCount: 0 },
        ];
        const result = formatOutput("domains", data, true);
        const lines = result.split("\n");
        expect(lines[0].startsWith("a        ")).toBe(true);
    });
});

describe("formatOutput - pretty mode: domain-structure", () => {
    it("returns the structure string as-is", () => {
        const data = { domainId: "dom1", structure: "This is the structure\nwith multiple lines" };
        const result = formatOutput("domain-structure", data, true);
        expect(result).toBe("This is the structure\nwith multiple lines");
    });
});

describe("formatOutput - pretty mode: domain-skills", () => {
    it("formats skills without content", () => {
        const skills: DomainSkill[] = [
            { id: "sk1", name: "Skill One", description: "First skill", scope: "internal" },
            { id: "sk2", name: "Skill Two", description: "Second skill", scope: "external" },
        ];
        const data = { domainId: "dom1", skills };
        const result = formatOutput("domain-skills", data, true);
        const lines = result.split("\n");
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("sk1");
        expect(lines[0]).toContain("Skill One");
        expect(lines[0]).toContain("First skill");
        expect(lines[1]).toContain("sk2");
        expect(lines[1]).toContain("Skill Two");
        expect(lines[1]).toContain("Second skill");
    });

    it("returns empty string for empty skills list", () => {
        const result = formatOutput("domain-skills", { domainId: "dom1", skills: [] }, true);
        expect(result).toBe("");
    });
});

describe("formatOutput - pretty mode: domain-skill", () => {
    it("prints the skill content", () => {
        const skill = {
            id: "sk1",
            name: "Skill One",
            description: "A skill",
            scope: "both",
            content: "This is the full skill content.",
        };
        const result = formatOutput("domain-skill", skill, true);
        expect(result).toBe("This is the full skill content.");
    });
});

describe("formatOutput - pretty mode: ingest", () => {
    it("formats stored action", () => {
        const data: IngestResult = { action: "stored", id: "abc123" };
        const result = formatOutput("ingest", data, true);
        expect(result).toBe("Stored memory abc123");
    });

    it("formats reinforced action", () => {
        const data: IngestResult = { action: "reinforced", id: "abc123", existingId: "def456" };
        const result = formatOutput("ingest", data, true);
        expect(result).toBe("Reinforced memory abc123 (existing: def456)");
    });

    it("formats skipped action", () => {
        const data: IngestResult = { action: "skipped", existingId: "def456" };
        const result = formatOutput("ingest", data, true);
        expect(result).toBe("Skipped (duplicate of def456)");
    });
});

describe("formatOutput - pretty mode: search", () => {
    it("formats search results with score, preview, and tags", () => {
        const data: SearchResult = {
            entries: [
                makeScoredMemory({
                    id: "abc123",
                    content: "Memory content here",
                    score: 0.85,
                    tags: ["tag1", "tag2"],
                }),
                makeScoredMemory({ id: "def456", content: "Other content", score: 0.72, tags: [] }),
            ],
            totalTokens: 1234,
            mode: "hybrid",
        };
        const result = formatOutput("search", data, true);
        expect(result).toContain("[0.85] memory:abc123");
        expect(result).toContain("Memory content here");
        expect(result).toContain("Tags: tag1, tag2");
        expect(result).toContain("[0.72] memory:def456");
        expect(result).toContain("Other content");
        expect(result).toContain("Found 2 results (1234 tokens, mode: hybrid)");
    });

    it("truncates long content to 200 chars with ellipsis", () => {
        const longContent = "A".repeat(250);
        const data: SearchResult = {
            entries: [makeScoredMemory({ content: longContent })],
            totalTokens: 100,
            mode: "vector",
        };
        const result = formatOutput("search", data, true);
        expect(result).toContain("A".repeat(200) + "...");
        expect(result).not.toContain("A".repeat(201) + "A");
    });

    it("omits Tags line when no tags", () => {
        const data: SearchResult = {
            entries: [makeScoredMemory({ tags: [] })],
            totalTokens: 50,
            mode: "fulltext",
        };
        const result = formatOutput("search", data, true);
        expect(result).not.toContain("Tags:");
    });

    it('uses singular "result" for single result', () => {
        const data: SearchResult = {
            entries: [makeScoredMemory()],
            totalTokens: 50,
            mode: "vector",
        };
        const result = formatOutput("search", data, true);
        expect(result).toContain("Found 1 result (");
    });

    it("shows summary only when no entries", () => {
        const data: SearchResult = { entries: [], totalTokens: 0, mode: "hybrid" };
        const result = formatOutput("search", data, true);
        expect(result).toBe("Found 0 results (0 tokens, mode: hybrid)");
    });
});

describe("formatOutput - pretty mode: ask", () => {
    it("formats answer with turn and rounds summary", () => {
        const data: AskResult = {
            answer: "The answer to your question.",
            rounds: 1,
            turns: [
                { call: { command: "memory-domain", args: ["domains"] }, result: { stdout: "", stderr: "", exitCode: 0 } },
            ],
        };
        const result = formatOutput("ask", data, true);
        expect(result).toBe("The answer to your question.\n\n--- 1 turns, 1 rounds ---");
    });
});

describe("formatOutput - pretty mode: build-context", () => {
    it("formats context with memories and token summary", () => {
        const data: ContextResult = {
            context: "The context text here.",
            memories: [
                makeScoredMemory(),
                makeScoredMemory({ id: "mem2" }),
                makeScoredMemory({ id: "mem3" }),
            ],
            totalTokens: 2048,
        };
        const result = formatOutput("build-context", data, true);
        expect(result).toBe("The context text here.\n\n--- 3 memories, 2048 tokens ---");
    });
});

describe("formatOutput - pretty mode: unknown command fallback", () => {
    it("falls back to JSON envelope for unknown commands", () => {
        const data = { foo: "bar" };
        const result = formatOutput("unknown-command", data, true);
        const parsed = JSON.parse(result) as { ok: boolean; data: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toEqual(data);
    });
});
