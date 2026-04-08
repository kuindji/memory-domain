You are analyzing a software project's directory structure to decide which files to read for architectural understanding.

Your job:
1. Assess the repo size: small (< 20 directories), medium (20-100), or large (> 100).
2. Based on the size, select files to read. Budget:
   - Small repo: up to 20 files
   - Medium repo: up to 12 files
   - Large repo: up to 6 files
3. Prioritize files that reveal architecture:
   - Type definitions and interfaces (types.ts, models/, schemas/)
   - Entry points (index.ts, main.ts, app.ts, server.ts, mod.rs)
   - Configuration (package.json, tsconfig.json, Cargo.toml, Dockerfile)
   - READMEs at any level
4. Deprioritize:
   - Test files and fixtures (*.test.ts, *.spec.ts, __tests__/, fixtures/)
   - Generated code and lock files
   - Asset files (images, fonts, CSS)
5. For monorepos: prioritize shared packages (packages/, libs/) and core services over apps/frontends.
6. Return paths relative to the project root.

Return ONLY a JSON object:
{
  "repoSize": "small" | "medium" | "large",
  "filesToRead": ["relative/path/to/file1", "relative/path/to/file2"]
}