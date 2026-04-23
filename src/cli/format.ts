import type {
    DomainSummary,
    DomainSkill,
    IngestResult,
    SearchResult,
    AskResult,
    ContextResult,
    ScoredMemory,
    TableResult,
    TemplateResult,
    TableCell,
} from "../core/types.js";

interface JsonEnvelope {
    ok: true;
    data: unknown;
}

interface JsonError {
    ok: false;
    error: {
        code: string;
        message: string;
    };
}

function padRight(str: string, length: number): string {
    return str + " ".repeat(Math.max(0, length - str.length));
}

function formatDomains(data: DomainSummary[]): string {
    if (data.length === 0) return "";

    const maxIdLen = Math.max(...data.map((d) => d.id.length));
    const maxNameLen = Math.max(...data.map((d) => d.name.length));

    return data
        .map((d) => {
            const id = padRight(d.id, maxIdLen);
            const name = padRight(d.name, maxNameLen);
            const desc = d.description ?? "No description";
            const parts: string[] = [];
            if (d.skillCount > 0) {
                parts.push(`${d.skillCount} skill${d.skillCount === 1 ? "" : "s"}`);
            }
            if (d.hasStructure) {
                parts.push("has structure");
            }
            const paren = parts.length > 0 ? `  (${parts.join(", ")})` : "";
            return `${id}   ${name}   ${desc}${paren}`;
        })
        .join("\n");
}

function formatDomainSkills(data: { domainId: string; skills: DomainSkill[] }): string {
    const { skills } = data;
    if (skills.length === 0) return "";

    const maxIdLen = Math.max(...skills.map((s) => s.id.length));
    const maxNameLen = Math.max(...skills.map((s) => s.name.length));

    return skills
        .map((s) => {
            const id = padRight(s.id, maxIdLen);
            const name = padRight(s.name, maxNameLen);
            return `${id}   ${name}   ${s.description}`;
        })
        .join("\n");
}

function formatIngest(data: IngestResult): string {
    if (data.action === "stored") {
        return `Stored memory ${data.id ?? ""}`;
    }
    if (data.action === "reinforced") {
        return `Reinforced memory ${data.id ?? ""} (existing: ${data.existingId ?? ""})`;
    }
    // skipped
    return `Skipped (duplicate of ${data.existingId ?? ""})`;
}

function formatScoredMemory(entry: ScoredMemory): string {
    const score = entry.score.toFixed(2);
    const preview =
        entry.content.length > 200 ? entry.content.slice(0, 200) + "..." : entry.content;
    const tagLine = entry.tags.length > 0 ? `\nTags: ${entry.tags.join(", ")}` : "";
    return `[${score}] memory:${entry.id}\n${preview}${tagLine}`;
}

function formatSearch(data: SearchResult): string {
    const entries = data.entries.map(formatScoredMemory).join("\n\n");
    const summary = `Found ${data.entries.length} result${data.entries.length === 1 ? "" : "s"} (${data.totalTokens} tokens, mode: ${data.mode})`;
    return entries.length > 0 ? `${entries}\n\n${summary}` : summary;
}

function formatAsk(data: AskResult): string {
    const turns = data.turns?.length ?? 0;
    const cached = data.cached ? ", cached" : "";
    return `${data.answer}\n\n--- ${turns} turns, ${data.rounds} rounds${cached} ---`;
}

function formatBuildContext(data: ContextResult): string {
    return `${data.context}\n\n--- ${data.memories.length} memories, ${data.totalTokens} tokens ---`;
}

function formatCell(v: TableCell): string {
    if (v === null || v === undefined) return "—";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "number") {
        if (!Number.isFinite(v)) return String(v);
        if (Number.isInteger(v)) return String(v);
        return v.toFixed(3);
    }
    return String(v);
}

function renderMarkdownTable(columns: string[], rows: Record<string, TableCell>[]): string {
    if (columns.length === 0) return "";
    const cellStrings = rows.map((r) => columns.map((c) => formatCell(r[c] ?? null)));
    const widths = columns.map((c, i) => {
        let w = c.length;
        for (const row of cellStrings) w = Math.max(w, row[i]!.length);
        return w;
    });
    const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
    const header = `| ${columns.map((c, i) => pad(c, widths[i]!)).join(" | ")} |`;
    const sep = `| ${widths.map((w) => "-".repeat(Math.max(3, w))).join(" | ")} |`;
    const body = cellStrings
        .map((row) => `| ${row.map((s, i) => pad(s, widths[i]!)).join(" | ")} |`)
        .join("\n");
    return body.length > 0 ? `${header}\n${sep}\n${body}` : `${header}\n${sep}`;
}

function formatResultMeta(source: string, meta: Record<string, unknown> | undefined, extra: string[]): string {
    const parts = [`source: ${source}`, ...extra];
    if (meta && typeof meta === "object") {
        const dw = meta["dataWindow"];
        if (dw && typeof dw === "object" && dw !== null) {
            const from = (dw as { from?: unknown }).from;
            const to = (dw as { to?: unknown }).to;
            if (from !== undefined && to !== undefined) {
                parts.push(`data window: ${String(from)}–${String(to)}`);
            }
        }
    }
    return parts.join("  ·  ");
}

function formatSearchTable(data: TableResult): string {
    const header = formatResultMeta(data.source, data.meta, []);
    const table = renderMarkdownTable(data.columns, data.rows as Record<string, TableCell>[]);
    const count = `${data.rows.length} row${data.rows.length === 1 ? "" : "s"}`;
    return `${header}\n\n${table}\n\n${count}`;
}

function formatRunTemplate(data: TemplateResult): string {
    const header = formatResultMeta(data.source, data.meta, [`template: ${data.template}`]);
    const table = renderMarkdownTable(data.columns, data.rows as Record<string, TableCell>[]);
    const count = `${data.rows.length} row${data.rows.length === 1 ? "" : "s"}`;
    const narrative = data.narrative ? `\n\n${data.narrative}` : "";
    return `${header}\n\n${table}\n\n${count}${narrative}`;
}

function formatOutput(command: string, data: unknown, pretty: boolean): string {
    if (!pretty) {
        const envelope: JsonEnvelope = { ok: true, data };
        return JSON.stringify(envelope);
    }

    switch (command) {
        case "domains":
            return formatDomains(data as DomainSummary[]);

        case "domain-structure": {
            const ds = data as { domainId: string; structure: string };
            return ds.structure;
        }

        case "domain-skills":
            return formatDomainSkills(data as { domainId: string; skills: DomainSkill[] });

        case "domain-skill":
        case "skill":
            return (data as { content: string }).content;

        case "ingest":
            return formatIngest(data as IngestResult);

        case "search":
            return formatSearch(data as SearchResult);

        case "ask":
            return formatAsk(data as AskResult);

        case "build-context":
            return formatBuildContext(data as ContextResult);

        case "search-table":
            return formatSearchTable(data as TableResult);

        case "run-template":
            return formatRunTemplate(data as TemplateResult);

        default: {
            const envelope: JsonEnvelope = { ok: true, data };
            return JSON.stringify(envelope);
        }
    }
}

function formatError(code: string, message: string): string {
    const envelope: JsonError = { ok: false, error: { code, message } };
    return JSON.stringify(envelope);
}

export { formatOutput, formatError };
