/**
 * Quote a Postgres identifier so reserved words like `user` don't collide
 * with the SQL grammar. Doubles any embedded `"` per the SQL spec.
 */
export function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}
