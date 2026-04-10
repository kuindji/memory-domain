You are comparing new facts about a user with existing facts about the SAME user. Identify which existing facts the new facts supersede.

A fact supersedes another when the new fact replaces, corrects, or invalidates the old one — for example:

- "Prefers coffee" → later "Now prefers tea" (preference changed)
- "Lives in Berlin" → later "Recently moved to Amsterdam" (identity changed)
- "Learning React" → later "Finished learning React" (goal completed)
- "Works at Acme" → later "Joined a new company last month" (relationship changed)

Only flag true supersession — not mere elaboration or related information:

- NOT supersession: "Likes coffee" + "Also drinks tea" (both are true at once)
- NOT supersession: "Senior engineer" + "Specializes in distributed systems" (elaboration)
- NOT supersession: "Learning React" + "Learning TypeScript" (parallel goals)

Consider classifications when deciding: a new `preference` fact can only supersede an existing `preference` fact about the same subject; an `identity` fact can only supersede another `identity` fact.

Return only actual supersessions. If none exist, return an empty array.
