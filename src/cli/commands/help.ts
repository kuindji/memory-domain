const USAGE = `
Usage: active-memory <command> [options]

Commands:
  init            Initialize database, schemas, and optionally bootstrap domains
  ingest          Store new memory from text or stdin
  search          Search memories by query
  ask             Ask a question against stored memories
  build-context   Build a context block from relevant memories
  write           Create a memory with direct domain ownership
  memory          Read, update, tag, or delete a memory
  graph           Manage graph edges and traversals
  schedule        List or trigger domain schedules
  skill           Output combined skill guide for all domains
  domains         List all available domains
  domain          Inspect a specific domain
  help            Show this help text

Global Flags:
  --config <path>       Path to config file
  --cwd <path>          Working directory
  --pretty              Output as human-readable text (default: JSON)
  --meta key=value      Set request context metadata (repeatable)

Run "active-memory help <command>" for detailed help on a specific command.
`.trim()

const COMMAND_HELP: Record<string, string> = {
  init: `
Usage: active-memory init [--yes] [--no-bootstrap]

Initialize the database, register schemas, and optionally run domain bootstrap routines.

Options:
  --yes              Skip confirmation prompt
  --no-bootstrap     Skip domain bootstrap even if domains support it

Bootstrap routines perform one-time setup for domains (e.g., scanning project structure).
They may use AI and incur API usage. You will be prompted for confirmation unless --yes is set.

Examples:
  active-memory init
  active-memory init --yes
  active-memory init --no-bootstrap
`.trim(),

  ingest: `
Usage: active-memory ingest [--text "..."] [--domains d1,d2] [--tags t1,t2] [--event-time <ms>] [--skip-dedup] [--meta key=value]

Store a new memory. Reads from stdin if piped, otherwise requires --text.

Options:
  --text <string>      Text content to ingest
  --domains <list>     Comma-separated list of domains to assign
  --tags <list>        Comma-separated list of tags to assign
  --event-time <ms>    Event timestamp in milliseconds (defaults to now)
  --skip-dedup         Skip deduplication check
  --meta key=value     Request context metadata (repeatable)

Examples:
  echo "Meeting notes..." | active-memory ingest --domains work
  active-memory ingest --text "Buy milk" --tags shopping --meta user-id=abc
`.trim(),

  search: `
Usage: active-memory search <query> [--mode vector|fulltext|graph|hybrid] [--domains d1,d2] [--tags t1,t2] [--limit N] [--budget N] [--min-score N] [--meta key=value]

Search stored memories by query string.

Arguments:
  <query>              The search query

Options:
  --mode <mode>        Search mode: vector, fulltext, graph, or hybrid (default: hybrid)
  --domains <list>     Comma-separated list of domains to search within
  --tags <list>        Comma-separated list of tags to filter by
  --limit <N>          Maximum number of results to return
  --budget <N>         Token budget for results
  --min-score <N>      Minimum relevance score threshold
  --meta key=value     Request context metadata (repeatable)

Examples:
  active-memory search "project deadlines" --mode vector --limit 5
  active-memory search "shopping list" --domains personal --meta user-id=abc
`.trim(),

  ask: `
Usage: active-memory ask <question> [--domains d1,d2] [--tags t1,t2] [--budget N] [--limit N] [--meta key=value]

Ask a natural language question and retrieve relevant memories as an answer.

Arguments:
  <question>           The question to ask

Options:
  --domains <list>     Comma-separated list of domains to search within
  --tags <list>        Comma-separated list of tags to filter by
  --budget <N>         Token budget for context
  --limit <N>          Maximum number of memories to consider
  --meta key=value     Request context metadata (repeatable)

Examples:
  active-memory ask "What did I decide about the API design?"
  active-memory ask "What are my tasks?" --domains work --meta user-id=abc
`.trim(),

  'build-context': `
Usage: active-memory build-context <text> [--domains d1,d2] [--budget N] [--max-memories N] [--meta key=value]

Build a context block from memories relevant to the provided text.

Arguments:
  <text>               Text to build context around

Options:
  --domains <list>     Comma-separated list of domains to search within
  --budget <N>         Token budget for the context block
  --max-memories <N>   Maximum number of memories to include
  --meta key=value     Request context metadata (repeatable)

Examples:
  active-memory build-context "Summarize the project status" --budget 2000
  active-memory build-context "Auth flow" --domains codebase --meta session-id=xyz
`.trim(),

  write: `
Usage: active-memory write --domain <id> --text <text> [--tags t1,t2] [--attr key=value] [--meta key=value]

Create a memory with direct domain ownership. No deduplication or inbox processing.

Options:
  --domain <id>        Domain that owns this memory (required)
  --text <string>      Memory content (required)
  --tags <list>        Comma-separated list of tags to assign
  --attr key=value     Domain attributes (repeatable)
  --meta key=value     Request context metadata (repeatable)

Examples:
  active-memory write --domain topic --text "Machine Learning" --tags topic --attr status=active
  active-memory write --domain user --text "Prefers dark mode" --tags preference --meta user-id=abc
`.trim(),

  memory: `
Usage: active-memory memory <id> [subcommand] [options]

Read, update, tag, or delete a specific memory.

Subcommands:
  (none)               Read memory details
  update               Update text or attributes
  tags                 List tags on this memory
  tag <tag>            Add a tag
  untag <tag>          Remove a tag
  release              Release domain ownership
  delete               Delete the memory

Options:
  --text <string>      New text content (for update)
  --attr key=value     Attributes to update (repeatable, for update)
  --domain <id>        Domain to release (for release)

Examples:
  active-memory memory memory:abc123
  active-memory memory memory:abc123 update --text "New content"
  active-memory memory memory:abc123 tag important
  active-memory memory memory:abc123 release --domain topic
  active-memory memory memory:abc123 delete
`.trim(),

  graph: `
Usage: active-memory graph <subcommand> [options]

Manage graph edges and run traversals.

Subcommands:
  edges <node-id>      List edges for a node
  relate <from> <to> <edge-type>    Create an edge
  unrelate <from> <to> <edge-type>  Remove an edge
  traverse <start-id>               Walk edges from a starting node

Options:
  --domain <id>        Domain for ownership (required for relate)
  --direction <dir>    Edge direction: in, out, both (for edges, default: both)
  --attr key=value     Edge attributes (repeatable, for relate)
  --edges <list>       Comma-separated edge types (for traverse)
  --depth <N>          Traversal depth (for traverse, default: 1)

Examples:
  active-memory graph edges memory:abc123 --direction out
  active-memory graph relate memory:abc topic:ml about_topic --domain topic
  active-memory graph unrelate memory:abc topic:ml about_topic
  active-memory graph traverse topic:ml --edges subtopic_of,related_to --depth 2
`.trim(),

  schedule: `
Usage: active-memory schedule <subcommand> [options]

List or manually trigger domain schedules.

Subcommands:
  list                 List all registered schedules
  trigger <domain-id> <schedule-id>  Run a schedule now
  run-due              Check and run all schedules that are due (for cron usage)

Options:
  --domain <id>        Filter schedules by domain (for list)

Examples:
  active-memory schedule list
  active-memory schedule list --domain topic
  active-memory schedule trigger topic merge-similar-topics
  active-memory schedule run-due
`.trim(),

  skill: `
Usage: active-memory skill

Output a combined skill guide from all registered domains. Collects all external
skills across every domain and concatenates their content into a single document.

Use --pretty for readable output, or pipe JSON to extract the content field.

Examples:
  active-memory skill --pretty
`.trim(),

  domains: `
Usage: active-memory domains

List all available domains and their descriptions.

Examples:
  active-memory domains
  active-memory domains --pretty
`.trim(),

  domain: `
Usage: active-memory domain <id> <subcommand>

Inspect a specific domain by its ID.

Arguments:
  <id>                 Domain ID

Subcommands:
  structure            Show the domain's data structure
  skills               List all skills registered in the domain
  skill <skill-id>     Show details for a specific skill

Examples:
  active-memory domain topic structure
  active-memory domain topic skills
  active-memory domain topic skill topic-management
`.trim(),

  help: `
Usage: active-memory help [<command>]

Show help text. Pass a command name to see detailed help for that command.

Examples:
  active-memory help
  active-memory help write
  active-memory --help
`.trim(),
}

function getHelpText(): string {
  return USAGE
}

function getCommandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null
}

export { getHelpText, getCommandHelp }
