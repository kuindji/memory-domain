**Important:** Always use `bun` instead of `npm` or `yarn` for installing dependencies and running TypeScript/Node commands.

**Important:** Do not add co-authored by when creating commits.

**Important:** Avoid using `as any` in typescript. Pursue proper type usage.

**Important:** Keep types reusable and where makes sense separate from implementation. Before adding new types make sure existing types don't already cover the ones you're creating.

**Important:** Don't export until necessary. If something is exported but never used anywhere, it should not be exported.

**Important:** Avoid disabling eslint rules when working on linting issues. Try to find proper solution.

**Important:** Run lint, typecheck and test commands after making changes. `bun format` before committing.
