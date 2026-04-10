# User Data Storage

User facts are memory entries linked to a user node in the graph. The user node is identified by a `userId` string.

## Storing a User Fact

Write a memory with the `user` domain and link it to the user node:

```sh
# Store a preference
node memory-domain write --domain user \
  --text "Prefers concise responses without bullet lists" \
  --tags user/preference \
  --meta userId=user-123

# Store an identity fact
node memory-domain write --domain user \
  --text "User prefers to be addressed as Alex" \
  --tags user/identity \
  --meta userId=user-123

# Store expertise
node memory-domain write --domain user \
  --text "Senior backend engineer with 10 years of Go experience" \
  --tags user/expertise \
  --meta userId=user-123

# Store a goal
node memory-domain write --domain user \
  --text "Learning React for a frontend project" \
  --tags user/goal \
  --meta userId=user-123
```

## Required metadata

Every user fact MUST include `userId` in its metadata (`--meta userId=<id>`). The inbox uses this to:
- link the memory to the correct `user:<userId>` node via an `about_user` edge
- scope supersession detection to facts about the same user (so that a new fact about user A cannot mark user B's fact superseded)

If `userId` is missing, the fact is stored but supersession and per-user linking will not apply to it.

## Tag Categories

| Tag | Use for | Classification |
|-----|---------|----------------|
| `user/identity` | Name, location, pronouns, identity attributes | identity |
| `user/preference` | Likes, dislikes, settings, communication style | preference |
| `user/expertise` | Skills, knowledge areas, professional background | expertise |
| `user/goal` | Current objectives, aspirations, ongoing projects | goal |
| `user/relationship` | Relationships with people, teams, companies | relationship |
| `user/habit` | Routines, schedules, repeated behaviors | habit |

Classifications are auto-derived by the inbox. You can also pre-set the classification explicitly via `--meta classification=preference` to skip LLM classification.

## Linking an Existing Memory to a User

If a memory already exists, create the edge directly:

```sh
memory-domain graph relate <memory-id> user:<userId> about_user --domain user
```
