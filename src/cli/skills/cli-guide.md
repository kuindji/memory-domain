# Memory Domain CLI

Memory Domain is a graph-backed memory engine. You interact with it through the `memory-domain` CLI.
Use project preferred runtime (node? bun?) to run this cli.

## Getting Help

`node memory-domain help`                  # list all commands
`bun memory-domain help <command>`        # detailed help for a command

## Domains

Each domain owns a slice of the memory graph and defines its own tags, attributes, edges, and schedules.

`node memory-domain domains --pretty`               # list all registered domains
`node memory-domain domain <id> structure --pretty` # show domain data structure
`node memory-domain domain <id> skills --pretty`    # list domain skills

## Storing Memories

**`ingest`** sends text through memory domain processing:

`node memory-domain ingest --text "<some-knowledge>" --domains <memory-domain>`

**`write`** creates a memory with direct ownership, bypassing processing:

`node memory-domain write --domain <domain> --text "<some-memory>" --tags topic --attr name="<name-value>" --attr status=<status-value>`

Use `ingest` when the domain should process the input. Use `write` when you know exactly what to store.

## Searching and Querying

`node memory-domain search "<query-text>" --domains <domain> --limit 5`
`node memory-domain search "<query-text>" --tags <tag> --mode vector`
`node memory-domain ask "<question-to-memory>" --domains <domain>`
`node memory-domain build-context "<input-to-build-context-for>" --domains <domain> --budget 4000`

## Graph Operations

`node memory-domain graph edges <node-id> --direction out`
`node memory-domain graph relate <from> <to> <edge-type> --domain <owner>`
`node memory-domain graph unrelate <from> <to> <edge-type>`
`node memory-domain graph traverse <start-id> --edges about_topic,subtopic_of --depth 2`

## Managing Memories

`node memory-domain memory <id>`                             # read
`node memory-domain memory <id> update --text "<new-text>"`  # update
`node memory-domain memory <id> tag <tag>`                   # add tag
`node memory-domain memory <id> untag <tag>`                 # remove tag
`node memory-domain memory <id> delete`                      # delete