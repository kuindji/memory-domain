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

## Tag Categories

| Tag | Use for |
|-----|---------|
| `user/identity` | Name, location, pronouns, identity attributes |
| `user/preference` | Likes, dislikes, settings, communication style |
| `user/expertise` | Skills, knowledge areas, professional background |
| `user/goal` | Current objectives, aspirations, ongoing projects |

## Linking an Existing Memory to a User

If a memory already exists, create the edge directly:

```sh
memory-domain graph relate <memory-id> user:<userId> about_user --domain user
```
