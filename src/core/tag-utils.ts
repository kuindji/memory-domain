export function formatTagId(label: string): string {
    const stripped = label.startsWith("tag:") ? label.slice(4) : label;
    // Text PKs under Postgres need no escaping — slashes, colons, spaces all OK.
    return `tag:${stripped}`;
}

export function tagLabel(label: string): string {
    return label.startsWith("tag:") ? label.slice(4) : label;
}
