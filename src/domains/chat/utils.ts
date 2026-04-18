import type { DomainContext } from "../../core/types.js";
import { formatTagId } from "../../core/tag-utils.js";

/**
 * Ensures a tag node exists in the graph with the given label.
 * Hierarchical tags (containing `/`) need backtick-escaping in SurrealDB
 * record IDs to prevent `/` being interpreted as a path separator.
 */
export async function ensureTag(context: DomainContext, label: string): Promise<string> {
    const tagId = formatTagId(label);
    try {
        await context.graph.createNodeWithId(tagId, { label, created_at: Date.now() });
    } catch {
        /* already exists */
    }
    return tagId;
}
