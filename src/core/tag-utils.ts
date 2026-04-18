export function formatTagId(label: string): string {
    const stripped = label.startsWith("tag:") ? label.slice(4) : label;
    return stripped.includes("/") ? `tag:\`${stripped}\`` : `tag:${stripped}`;
}

export function tagLabel(label: string): string {
    return label.startsWith("tag:") ? label.slice(4) : label;
}
