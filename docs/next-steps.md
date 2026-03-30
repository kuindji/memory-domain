The following plan touches many parts of the project. When creating implementation plan, sort the tasks 
by their dependecies.

# Domain 
- Domain should define and expose its internal data structure. The structure is not limited in any way as long as domain can clearly describe it. Which tags it uses, what do they mean. What unstructured text data it stores, etc.
This is for consumption by agents. It doesn't matter in which context agent is running - outer consumer agent, or internal domain agent, when they want to work with given domain, they should be able to understand its structure.
Whether the structure is defined as json-like or plain md - not decided yet. md could be enough.
- Domains should have multiple skill md files inside their codebase. It does not include the structure mentioned above, but implies it. Basically, it tells how to work with the data structure. Each agentic operation inside domain codebase should have its own skill file - this will be used as system prompt. Whenever agent is used in ingestion or scheduled processing - it should use one of these files. 
Skills can be internal or external (available for other domains or outer agents) or both.
One external skill is consumption skill. This one is telling other agents how to use this domain's data. 
Domain may define its ingestion skill as external. This is for cases when it doesn't process inbox itself, but other agents create this domain's data in their operations.
- In domain settings there should a setting that defines what other domains this domain can read data from. If omitted, it means all domains. `includeDomains` limits to certain domains, `excludeDomains` means all except these. Domain context should enforce these rules when domain internal logic uses search() or other methods. 

On abstract level the skill and structure parts don't really imply any code changes in main active-memory package. This should be rather a set of rules defined in files and followed when implementing domains. 
It may result in some abstract code interface or changes to domain context class.

# Config
The host project should have active-memory.config.js (or something similar) that creates and exports engine instance. In this file engine is created, domains are instantiated with their settings and added to engine.
This file doesn't start anything - internal schedules should automatically start, ingestion and inbox processing should not automatically start. 

# CLI

I'd make it a thin sh wrapper that detects runtime (bun vs node), and runs cli.js  
cli.js then parses arguments, finds config file, creates engine and does whatever is needed based on arguments.

## Interface 
CLI interface should reflect internal api: ingest(), search(), ask(), buildContext(). 
`active-memory ingest`
`active-memory search`
`active-memory ask`
`active-memory build-context`

In addition to these other methods should be available:
`active-memory domains` displays a list of domains and their descriptions
`active-memory domain <id> structure` displays domain's data structure
`active-memory domain <id> skills` displays a list of domain's external skills 
`active-memory domain <id> skill <skill-id>` prints the skill

`active-memory help`, `active-memory --help` displays cli usage. 

### Data manipulation through cli 
Whatever is described in domain's extrernal skills should be doable via cli and internal api.

# User domain 
This is a built-in knowledge domain about a user sitting behind consumer agent. 
- This domain does not process inbox. 
- Lets do a research on what kind of data about users collected in other memory systems and come up with data structure. 
- Lets decide whether this domain will have its own scheduled processing.
- This domain should have external skill for creating user data (instead of inbox processing).

# Chat domain and topic domain

## Chat domain
This is a built-in conversational memory. 
- Lets do a research on how other memory services are doing it. My idea of how it should work is briefly implemented in /Users/kuindji/Projects/AiMemory
- Domain will probably process inbox. Each user input goes to inbox. Agent outputs do not go to inbox, agent itself decides what to save. 
- Domain's main concern is conversation itself and following topics. All user specific data goes to User domain. It should use User domain external skill for this.

## Topic domain 
This is something that initially looks like chat domain's concern, but I think it can be shared with other domains as well. We've already have some implementation for this in Silentium/Nexus projects. 
I think topic domain should be built-in and shared by multiple other domains. Lets call it a primitive. 
Another primitive we may move to built-in is region. 

# Project domain 
After all of of this is done, we will revice project domain plan.

