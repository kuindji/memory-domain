## Tabular tool

`search-table <domain> [--filter <json>] [--filter-file <path>]` runs a domain's tabular query (`domain.search.execute`). Returns `{columns, rows, source, rowMeta?}`.

The `--filter` value is a single JSON-encoded string. Embedded quotes must be escaped — `args` is a flat array of strings (the shell argv), never a structured object.

Good example:
  {"tool":"search-table","args":["<domain>","--filter","{\"field\":\"value\",\"range\":{\"from\":1,\"to\":10}}"]}

Bad example (illegal — args must contain only strings, never bare JSON fragments):
  {"tool":"search-table","args":["<domain>","field":["value"]]}
