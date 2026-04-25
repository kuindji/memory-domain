/**
 * Translate Surreal-style FieldDef.type strings into Postgres column types.
 * Domains and plugins author schemas using the legacy syntax; rather than
 * forcing a sweeping rename, the schema layer normalizes here.
 */

export interface ColumnSpec {
    pgType: string;
    nullable: boolean;
}

const BASE_TYPE_MAP: Record<string, string> = {
    string: "text",
    int: "bigint",
    integer: "bigint",
    number: "double precision",
    float: "double precision",
    decimal: "numeric",
    bool: "boolean",
    boolean: "boolean",
    bytes: "bytea",
    object: "jsonb",
    record: "text",
    datetime: "timestamptz",
    duration: "interval",
};

export function translateFieldType(rawType: string): ColumnSpec {
    let type = rawType.trim();
    let nullable = false;

    const optionMatch = type.match(/^option<(.+)>$/i);
    if (optionMatch) {
        nullable = true;
        type = optionMatch[1].trim();
    }

    // array<float>, array<string>, set<...>, etc. → jsonb (consumers handle).
    if (/^(array|set)</i.test(type)) {
        return { pgType: "jsonb", nullable };
    }

    // record<table>, record<a|b> → plain text id.
    if (/^record</i.test(type)) {
        return { pgType: "text", nullable };
    }

    const lower = type.toLowerCase();
    const mapped = BASE_TYPE_MAP[lower];
    if (mapped) return { pgType: mapped, nullable };

    // Unknown type — fall through to jsonb. Better to over-flexibly store than
    // to throw and break unrelated domain registrations.
    return { pgType: "jsonb", nullable };
}

export function quoteSqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

export function defaultLiteral(value: string | number | boolean | null): string {
    if (value === null) return "NULL";
    if (typeof value === "string") return quoteSqlString(value);
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return String(value);
}
