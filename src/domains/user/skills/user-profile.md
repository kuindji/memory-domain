# User Profile Consolidation (Internal)

This skill describes the consolidation logic run by the user domain schedule.

## Finding All User Nodes

Search for all user records in the graph:
`node memory-domain search "" --domains user --tags user/profile-summary`

## Collecting Linked Data
For each user node, retrieve all incoming edges and resolve the linked memories:
`node memory-domain graph edges user:<userId> --direction in`

Then read each linked memory:
`memory-domain memory <memory-id>`

## LLM Synthesis

The schedule passes all collected memory contents to an LLM consolidation step that produces a unified profile summary.

## Summary Update Strategy

- If a profile summary memory already exists for this user (identified by having an `about_user` edge pointing to the same user node), update its content in place:
`memory-domain memory <existing-summary-id> update --text "<consolidated-summary>"`

- If no summary exists, create a new memory and link it to the user node:
`memory-domain write --domain user --text "<consolidated-summary>" --tags user/profile-summary`
`memory-domain graph relate <summary-id> user:<userId> about_user --domain user`

## Notes

- Skip user nodes that have no linked memory edges.
- Skip LLM calls when there is no content to consolidate.
- Do not duplicate summaries — always check for an existing summary before creating a new one.
