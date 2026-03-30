# Domain Foundation & Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add domain structure definitions, domain skills, domain visibility settings, config file loader, and engine introspection API.

**Architecture:** Domains gain three new optional properties: `structure` (markdown describing data layout), `skills` (agent-consumable prompt files), and `settings` (visibility rules). DomainContext enforces visibility when domains search across each other. A config loader discovers and imports `active-memory.config.*` files. Scheduling and inbox processing remain fully manual — the consumer decides when to start them.

**Tech Stack:** TypeScript, Bun, SurrealDB

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/core/types.ts` | Add `DomainSkill`, `DomainSettings` types; update `DomainConfig`, `DomainContext` |
| Modify | `src/core/domain-registry.ts` | Add methods for skill/structure introspection |
| Modify | `src/core/engine.ts` | Settings persistence, visibility enforcement in context |
| Modify | `src/index.ts` | Export new types, config loader |
| Create | `src/config-loader.ts` | Config file discovery and dynamic import |
| Create | `tests/domain-skills.test.ts` | Skills and structure registration tests |
| Create | `tests/domain-visibility.test.ts` | includeDomains/excludeDomains enforcement tests |
| Create | `tests/config-loader.test.ts` | Config file loading tests |

---

### Task 1: Add New Types

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Add DomainSkill and DomainSettings types**

Add after the `DomainSchedule` interface (line 197):

```typescript
export interface DomainSkill {
  id: string
  name: string
  description: string
  scope: 'internal' | 'external' | 'both'
  content: string
}

export interface DomainSettings {
  includeDomains?: string[]
  excludeDomains?: string[]
}
```

- [ ] **Step 2: Update DomainConfig with new fields**

Add three new optional fields to `DomainConfig` (before `processInboxItem`):

```typescript
export interface DomainConfig {
  id: string
  name: string
  schema?: DomainSchema
  structure?: string
  skills?: DomainSkill[]
  settings?: DomainSettings
  processInboxItem(entry: OwnedMemory, context: DomainContext): Promise<void>
  search?: {
    rank?(query: SearchQuery, candidates: ScoredMemory[]): ScoredMemory[]
    expand?(query: SearchQuery, context: DomainContext): Promise<SearchQuery>
  }
  buildContext?(text: string, budgetTokens: number, context: DomainContext): Promise<ContextResult>
  describe?(): string
  schedules?: DomainSchedule[]
}
```

- [ ] **Step 3: Add getVisibleDomains to DomainContext**

Add to the `DomainContext` interface:

```typescript
export interface DomainContext {
  domain: string
  graph: GraphApi
  llm: LLMAdapter
  getVisibleDomains(): string[]
  getMemory(id: string): Promise<MemoryEntry | null>
  getMemories(filter?: MemoryFilter): Promise<MemoryEntry[]>
  writeMemory(entry: WriteMemoryEntry): Promise<string>
  addTag(path: string): Promise<void>
  tagMemory(memoryId: string, tagId: string): Promise<void>
  untagMemory(memoryId: string, tagId: string): Promise<void>
  getTagDescendants(tagPath: string): Promise<string[]>
  addOwnership(memoryId: string, domainId: string, attributes?: Record<string, unknown>): Promise<void>
  releaseOwnership(memoryId: string, domainId: string): Promise<void>
  updateAttributes(memoryId: string, attributes: Record<string, unknown>): Promise<void>
  search(query: Omit<SearchQuery, 'domains'>): Promise<SearchResult>
  getMeta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: Errors in `engine.ts` because `createDomainContext` doesn't yet return `getVisibleDomains`. This is expected and will be fixed in Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add DomainSkill, DomainSettings types and update DomainConfig"
```

---

### Task 2: Domain Skills and Structure Registration

**Files:**
- Create: `tests/domain-skills.test.ts`
- Modify: `src/core/domain-registry.ts`

- [ ] **Step 1: Write tests for skill and structure access**

Create `tests/domain-skills.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'
import type { DomainConfig, OwnedMemory, DomainContext } from '../src/core/types.ts'

describe('Domain skills and structure', () => {
  let engine: MemoryEngine

  const testDomain: DomainConfig = {
    id: 'test-domain',
    name: 'Test Domain',
    structure: `# Test Domain Structure

## Tags
- \`test/category\` - Categorization tag
- \`test/priority\` - Priority level

## Attributes
- \`kind\`: string - The type of test entry (unit, integration, e2e)
- \`severity\`: string - How critical (low, medium, high)
`,
    skills: [
      {
        id: 'consumption',
        name: 'How to use Test Domain data',
        description: 'Tells external agents how to query and interpret test domain data',
        scope: 'external',
        content: 'When querying the test domain, use tags test/category to filter by type.',
      },
      {
        id: 'ingestion',
        name: 'How to create Test Domain data',
        description: 'Tells external agents how to create data for this domain',
        scope: 'external',
        content: 'Create entries with kind attribute set to unit, integration, or e2e.',
      },
      {
        id: 'analyze',
        name: 'Internal analysis',
        description: 'Used by domain agent to analyze test results',
        scope: 'internal',
        content: 'Analyze test results by grouping by kind and severity.',
      },
      {
        id: 'summarize',
        name: 'Summarize test results',
        description: 'Can be used internally or by other agents',
        scope: 'both',
        content: 'Summarize test results across all categories.',
      },
    ],
    async processInboxItem(_entry: OwnedMemory, _context: DomainContext) {
      // no-op
    },
  }

  const minimalDomain: DomainConfig = {
    id: 'minimal',
    name: 'Minimal Domain',
    async processInboxItem(_entry: OwnedMemory, _context: DomainContext) {
      // no-op
    },
  }

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
    await engine.registerDomain(testDomain)
    await engine.registerDomain(minimalDomain)
  })

  afterEach(async () => {
    await engine.close()
  })

  test('getDomainRegistry exposes domain structure', () => {
    const registry = engine.getDomainRegistry()
    const domain = registry.get('test-domain')
    expect(domain?.structure).toContain('## Tags')
    expect(domain?.structure).toContain('test/category')
  })

  test('domain without structure returns undefined', () => {
    const registry = engine.getDomainRegistry()
    const domain = registry.get('minimal')
    expect(domain?.structure).toBeUndefined()
  })

  test('getExternalSkills returns only external and both-scoped skills', () => {
    const registry = engine.getDomainRegistry()
    const skills = registry.getExternalSkills('test-domain')
    expect(skills.length).toBe(3)
    expect(skills.map(s => s.id).sort()).toEqual(['consumption', 'ingestion', 'summarize'])
  })

  test('getInternalSkills returns only internal and both-scoped skills', () => {
    const registry = engine.getDomainRegistry()
    const skills = registry.getInternalSkills('test-domain')
    expect(skills.length).toBe(2)
    expect(skills.map(s => s.id).sort()).toEqual(['analyze', 'summarize'])
  })

  test('getSkill returns specific skill by id', () => {
    const registry = engine.getDomainRegistry()
    const skill = registry.getSkill('test-domain', 'consumption')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('How to use Test Domain data')
    expect(skill!.scope).toBe('external')
  })

  test('getSkill returns undefined for nonexistent skill', () => {
    const registry = engine.getDomainRegistry()
    const skill = registry.getSkill('test-domain', 'nonexistent')
    expect(skill).toBeUndefined()
  })

  test('domain without skills returns empty arrays', () => {
    const registry = engine.getDomainRegistry()
    expect(registry.getExternalSkills('minimal')).toEqual([])
    expect(registry.getInternalSkills('minimal')).toEqual([])
  })

  test('listDomainSummaries returns id, name, and description for all domains', () => {
    const registry = engine.getDomainRegistry()
    const summaries = registry.listSummaries()
    const testSummary = summaries.find(s => s.id === 'test-domain')
    expect(testSummary).toBeDefined()
    expect(testSummary!.name).toBe('Test Domain')
    expect(testSummary!.hasStructure).toBe(true)
    expect(testSummary!.skillCount).toBe(4)

    const minimalSummary = summaries.find(s => s.id === 'minimal')
    expect(minimalSummary).toBeDefined()
    expect(minimalSummary!.hasStructure).toBe(false)
    expect(minimalSummary!.skillCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/domain-skills.test.ts`
Expected: FAIL — `getExternalSkills`, `getInternalSkills`, `getSkill`, `listSummaries` don't exist on DomainRegistry.

- [ ] **Step 3: Add skill and introspection methods to DomainRegistry**

In `src/core/domain-registry.ts`, add the following types and methods:

```typescript
import type { DomainConfig, DomainSkill } from './types.ts'

interface DomainSummary {
  id: string
  name: string
  description?: string
  hasStructure: boolean
  skillCount: number
}

export class DomainRegistry {
  private domains = new Map<string, DomainConfig>()

  register(domain: DomainConfig): void {
    if (this.domains.has(domain.id)) {
      throw new Error(`Domain "${domain.id}" is already registered`)
    }
    this.domains.set(domain.id, domain)
  }

  unregister(domainId: string): void {
    if (domainId === 'log') {
      throw new Error('Cannot unregister the built-in log domain')
    }
    this.domains.delete(domainId)
  }

  get(domainId: string): DomainConfig | undefined {
    return this.domains.get(domainId)
  }

  getOrThrow(domainId: string): DomainConfig {
    const domain = this.domains.get(domainId)
    if (!domain) throw new Error(`Domain "${domainId}" not found`)
    return domain
  }

  list(): DomainConfig[] {
    return [...this.domains.values()]
  }

  has(domainId: string): boolean {
    return this.domains.has(domainId)
  }

  getAllDomainIds(): string[] {
    return [...this.domains.keys()]
  }

  getExternalSkills(domainId: string): DomainSkill[] {
    const domain = this.domains.get(domainId)
    if (!domain?.skills) return []
    return domain.skills.filter(s => s.scope === 'external' || s.scope === 'both')
  }

  getInternalSkills(domainId: string): DomainSkill[] {
    const domain = this.domains.get(domainId)
    if (!domain?.skills) return []
    return domain.skills.filter(s => s.scope === 'internal' || s.scope === 'both')
  }

  getSkill(domainId: string, skillId: string): DomainSkill | undefined {
    const domain = this.domains.get(domainId)
    return domain?.skills?.find(s => s.id === skillId)
  }

  listSummaries(): DomainSummary[] {
    return this.list().map(d => ({
      id: d.id,
      name: d.name,
      description: d.describe?.(),
      hasStructure: d.structure != null,
      skillCount: d.skills?.length ?? 0,
    }))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/domain-skills.test.ts`
Expected: All PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/domain-registry.ts tests/domain-skills.test.ts
git commit -m "feat: add domain skills and structure introspection to DomainRegistry"
```

---

### Task 3: Domain Visibility Enforcement

**Files:**
- Create: `tests/domain-visibility.test.ts`
- Modify: `src/core/engine.ts`

- [ ] **Step 1: Write tests for visibility enforcement**

Create `tests/domain-visibility.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryEngine } from '../src/core/engine.ts'
import { MockLLMAdapter } from './helpers.ts'
import type { DomainConfig, OwnedMemory, DomainContext } from '../src/core/types.ts'

describe('Domain visibility', () => {
  let engine: MemoryEngine

  const domainA: DomainConfig = {
    id: 'domain-a',
    name: 'Domain A',
    settings: { includeDomains: ['domain-b'] },
    async processInboxItem(_entry: OwnedMemory, _ctx: DomainContext) {},
  }

  const domainB: DomainConfig = {
    id: 'domain-b',
    name: 'Domain B',
    async processInboxItem(_entry: OwnedMemory, _ctx: DomainContext) {},
  }

  const domainC: DomainConfig = {
    id: 'domain-c',
    name: 'Domain C',
    settings: { excludeDomains: ['domain-a'] },
    async processInboxItem(_entry: OwnedMemory, _ctx: DomainContext) {},
  }

  const domainD: DomainConfig = {
    id: 'domain-d',
    name: 'Domain D',
    async processInboxItem(_entry: OwnedMemory, _ctx: DomainContext) {},
  }

  beforeEach(async () => {
    engine = new MemoryEngine()
    await engine.initialize({
      connection: 'mem://',
      namespace: 'test',
      database: `test_${Date.now()}`,
      llm: new MockLLMAdapter(),
    })
    await engine.registerDomain(domainA)
    await engine.registerDomain(domainB)
    await engine.registerDomain(domainC)
    await engine.registerDomain(domainD)

    // Ingest data owned by each domain
    await engine.ingest('content from A', { domains: ['domain-a'] })
    await engine.ingest('content from B', { domains: ['domain-b'] })
    await engine.ingest('content from C', { domains: ['domain-c'] })
    await engine.ingest('content from D', { domains: ['domain-d'] })
  })

  afterEach(async () => {
    await engine.close()
  })

  test('getVisibleDomains with includeDomains returns only listed domains plus self', () => {
    const ctx = engine.createDomainContext('domain-a')
    const visible = ctx.getVisibleDomains()
    expect(visible.sort()).toEqual(['domain-a', 'domain-b'])
  })

  test('getVisibleDomains with excludeDomains returns all except excluded plus self', () => {
    const ctx = engine.createDomainContext('domain-c')
    const visible = ctx.getVisibleDomains()
    expect(visible).toContain('domain-c')
    expect(visible).toContain('domain-b')
    expect(visible).toContain('domain-d')
    expect(visible).not.toContain('domain-a')
  })

  test('getVisibleDomains with no settings returns all domains', () => {
    const ctx = engine.createDomainContext('domain-b')
    const visible = ctx.getVisibleDomains()
    expect(visible).toContain('domain-a')
    expect(visible).toContain('domain-b')
    expect(visible).toContain('domain-c')
    expect(visible).toContain('domain-d')
  })

  test('search from domain with includeDomains only finds visible data', async () => {
    // domain-a can only see domain-b (and itself)
    const ctx = engine.createDomainContext('domain-a')
    const result = await ctx.search({ mode: 'fulltext', text: 'content' })
    const contents = result.entries.map(e => e.content)
    expect(contents).toContain('content from A')
    expect(contents).toContain('content from B')
    expect(contents).not.toContain('content from C')
    expect(contents).not.toContain('content from D')
  })

  test('search from domain with excludeDomains hides excluded data', async () => {
    // domain-c excludes domain-a
    const ctx = engine.createDomainContext('domain-c')
    const result = await ctx.search({ mode: 'fulltext', text: 'content' })
    const contents = result.entries.map(e => e.content)
    expect(contents).toContain('content from C')
    expect(contents).toContain('content from B')
    expect(contents).toContain('content from D')
    expect(contents).not.toContain('content from A')
  })

  test('search from domain with no settings sees all data', async () => {
    const ctx = engine.createDomainContext('domain-d')
    const result = await ctx.search({ mode: 'fulltext', text: 'content' })
    expect(result.entries.length).toBeGreaterThanOrEqual(4)
  })

  test('getMemories from domain with includeDomains respects visibility', async () => {
    const ctx = engine.createDomainContext('domain-a')
    const memories = await ctx.getMemories()
    const contents = memories.map(m => m.content)
    expect(contents).toContain('content from A')
    expect(contents).toContain('content from B')
    expect(contents).not.toContain('content from C')
    expect(contents).not.toContain('content from D')
  })

  test('domain settings stored in DB node', async () => {
    const graph = engine.getGraph()
    const node = await graph.getNode('domain:domain-a')
    expect(node).toBeDefined()
    const settings = node!.settings as Record<string, unknown>
    expect(settings).toBeDefined()
    expect(settings.includeDomains).toEqual(['domain-b'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/domain-visibility.test.ts`
Expected: FAIL — `getVisibleDomains` doesn't exist, settings not stored.

- [ ] **Step 3: Store domain settings in DB during registration**

In `src/core/engine.ts`, update `registerDomain` to persist settings:

Change the `graph.createNodeWithId` call in `registerDomain` from:

```typescript
    try {
      await this.graph.createNodeWithId(`domain:${domain.id}`, {
        name: domain.name,
      })
    } catch {
      // Already exists — that's fine
    }
```

to:

```typescript
    const domainData: Record<string, unknown> = { name: domain.name }
    if (domain.settings) {
      domainData.settings = domain.settings
    }
    try {
      await this.graph.createNodeWithId(`domain:${domain.id}`, domainData)
    } catch {
      // Already exists — update settings if provided
      if (domain.settings) {
        await this.graph.updateNode(`domain:${domain.id}`, { settings: domain.settings })
      }
    }
```

- [ ] **Step 4: Add visibility resolution helper**

In `src/core/engine.ts`, add a private method before `createDomainContext`:

```typescript
  private resolveVisibleDomains(domainId: string): string[] {
    const domain = this.domainRegistry.get(domainId)
    const allIds = this.domainRegistry.getAllDomainIds()

    if (!domain?.settings?.includeDomains && !domain?.settings?.excludeDomains) {
      return allIds
    }

    if (domain.settings.includeDomains) {
      const allowed = new Set(domain.settings.includeDomains)
      allowed.add(domainId)
      return allIds.filter(id => allowed.has(id))
    }

    if (domain.settings.excludeDomains) {
      const blocked = new Set(domain.settings.excludeDomains)
      blocked.delete(domainId)
      return allIds.filter(id => !blocked.has(id))
    }

    return allIds
  }
```

- [ ] **Step 5: Update createDomainContext to implement getVisibleDomains and enforce visibility**

In `src/core/engine.ts`, in the `createDomainContext` method, add the `visibleDomains` computation and the `getVisibleDomains` method. Also update `search` and `getMemories` to use visible domains.

At the top of `createDomainContext`, after the existing local variable declarations, add:

```typescript
    const visibleDomains = this.resolveVisibleDomains(domainId)
```

Add to the returned object (after the `llm` property):

```typescript
      getVisibleDomains(): string[] {
        return [...visibleDomains]
      },
```

Update the `search` method in the returned context from:

```typescript
      async search(query: Omit<SearchQuery, 'domains'>): Promise<SearchResult> {
        return search({ ...query, domains: [domainId] })
      },
```

to:

```typescript
      async search(query: Omit<SearchQuery, 'domains'>): Promise<SearchResult> {
        return search({ ...query, domains: visibleDomains })
      },
```

Update the `getMemories` method — change the `targetDomains` line from:

```typescript
        const targetDomains = filter?.domains ?? [domainId]
```

to:

```typescript
        const requestedDomains = filter?.domains ?? visibleDomains
        const targetDomains = requestedDomains.filter(d => visibleDomains.includes(d))
```

- [ ] **Step 6: Run visibility tests**

Run: `bun test tests/domain-visibility.test.ts`
Expected: All PASS

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass. Existing tests should be unaffected since domains without settings get `allIds` (same as before, but now searches across all domains instead of just self).

**Important:** If existing tests fail because `search` in DomainContext now returns results from all domains instead of just the caller's domain, this is a behavioral change that needs attention. The previous behavior was `domains: [domainId]` (self only). The new behavior is `domains: visibleDomains` (all allowed). Check if any existing tests relied on the self-only scoping. If so, those domains should set `settings: { includeDomains: [] }` or the tests should be updated to account for cross-domain results.

If tests fail, the fix is to make the default behavior match the old behavior when no settings are defined. In that case, change `resolveVisibleDomains` to return `[domainId]` when settings is undefined, and add a new method or flag to opt into cross-domain visibility. **However**, the spec says "If omitted, it means all domains" — so the new behavior is correct per spec. Update failing tests to expect cross-domain results.

- [ ] **Step 8: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/engine.ts tests/domain-visibility.test.ts
git commit -m "feat: add domain visibility settings with includeDomains/excludeDomains enforcement"
```

---

### Task 4: Config File Loader

**Files:**
- Create: `src/config-loader.ts`
- Create: `tests/config-loader.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write tests for config loader**

Create `tests/config-loader.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { resolveConfigPath } from '../src/config-loader.ts'

describe('Config loader', () => {
  const tmpDir = join(import.meta.dir, '__config_test_tmp')

  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  test('resolveConfigPath finds active-memory.config.ts', () => {
    writeFileSync(join(tmpDir, 'active-memory.config.ts'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'active-memory.config.ts'))
  })

  test('resolveConfigPath finds active-memory.config.js', () => {
    writeFileSync(join(tmpDir, 'active-memory.config.js'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'active-memory.config.js'))
  })

  test('resolveConfigPath finds active-memory.config.mjs', () => {
    writeFileSync(join(tmpDir, 'active-memory.config.mjs'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'active-memory.config.mjs'))
  })

  test('resolveConfigPath prefers .ts over .js', () => {
    writeFileSync(join(tmpDir, 'active-memory.config.ts'), 'export default {}')
    writeFileSync(join(tmpDir, 'active-memory.config.js'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'active-memory.config.ts'))
  })

  test('resolveConfigPath returns null when no config found', () => {
    const result = resolveConfigPath(tmpDir)
    expect(result).toBeNull()
  })

  test('resolveConfigPath accepts explicit path', () => {
    const customPath = join(tmpDir, 'custom.config.ts')
    writeFileSync(customPath, 'export default {}')
    const result = resolveConfigPath(tmpDir, customPath)
    expect(result).toBe(customPath)
  })

  test('resolveConfigPath throws for explicit path that does not exist', () => {
    expect(() => resolveConfigPath(tmpDir, '/nonexistent/path.ts')).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config-loader.test.ts`
Expected: FAIL — `resolveConfigPath` doesn't exist.

- [ ] **Step 3: Implement config loader**

Create `src/config-loader.ts`:

```typescript
import { existsSync } from 'fs'
import { join, isAbsolute } from 'path'
import type { MemoryEngine } from './core/engine.ts'

const CONFIG_NAMES = [
  'active-memory.config.ts',
  'active-memory.config.js',
  'active-memory.config.mjs',
]

function resolveConfigPath(cwd: string, explicitPath?: string): string | null {
  if (explicitPath) {
    const resolved = isAbsolute(explicitPath) ? explicitPath : join(cwd, explicitPath)
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`)
    }
    return resolved
  }

  for (const name of CONFIG_NAMES) {
    const candidate = join(cwd, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

async function loadConfig(cwd?: string, configPath?: string): Promise<MemoryEngine> {
  const dir = cwd ?? process.cwd()
  const resolved = resolveConfigPath(dir, configPath)

  if (!resolved) {
    throw new Error(
      `No active-memory config file found in ${dir}. ` +
      `Expected one of: ${CONFIG_NAMES.join(', ')}`
    )
  }

  const mod = await import(resolved) as { default?: MemoryEngine }

  if (!mod.default) {
    throw new Error(
      `Config file ${resolved} must have a default export of a MemoryEngine instance`
    )
  }

  return mod.default
}

export { resolveConfigPath, loadConfig }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/config-loader.test.ts`
Expected: All PASS

- [ ] **Step 5: Export config loader from index**

In `src/index.ts`, add at the end:

```typescript
// Config
export { resolveConfigPath, loadConfig } from './config-loader.ts'
```

- [ ] **Step 6: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/config-loader.ts tests/config-loader.test.ts src/index.ts
git commit -m "feat: add config file loader with auto-discovery"
```

---

### Task 5: Export New Types and Final Verification

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Export new types from index**

In `src/index.ts`, add `DomainSkill` and `DomainSettings` to the type exports:

```typescript
export type {
  EngineConfig,
  GraphApi,
  Node,
  Edge,
  DomainConfig,
  DomainContext,
  DomainSchema,
  DomainSchedule,
  DomainSkill,
  DomainSettings,
  WriteMemoryEntry,
  NodeDef,
  EdgeDef,
  FieldDef,
  IndexDef,
  MemoryFilter,
  SearchQuery,
  SearchResult,
  ScoredMemory,
  MemoryEntry,
  OwnedMemory,
  Tag,
  MemoryOwnership,
  Reference,
  ReferenceType,
  IngestOptions,
  IngestResult,
  RepetitionConfig,
  ContextOptions,
  ContextResult,
  AskOptions,
  AskResult,
  LLMAdapter,
  EmbeddingAdapter,
  MemoryEventName,
} from './core/types.ts'
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: export DomainSkill and DomainSettings types"
```

---

## Notes for Implementer

### Behavioral Change in DomainContext.search()

The old behavior scoped `search()` to `domains: [domainId]` (self only). The new behavior scopes to `domains: visibleDomains` (all allowed domains, which is all domains when no settings are defined). This matches the spec: "If omitted, it means all domains."

If existing tests fail because of this, update them — the new behavior is intentional. Domains that need isolation should set `settings: { includeDomains: [] }` (empty array = self only since self is always added).

### Config File Contract

The config file is expected to:
1. Create a `MemoryEngine` instance
2. Call `engine.initialize(...)` with connection and adapter config
3. Register all domains via `engine.registerDomain(...)`
4. Export the engine as `default`
5. NOT call `startProcessing()` — the consumer decides when to start scheduling and inbox processing

A consumer app (e.g. an agent) would import the config and only call `ingest()`, `search()`, `ask()`, `buildContext()`. A separate server-side process with the same config would call `startProcessing()` to run schedules and inbox processing.

Example config:
```typescript
// active-memory.config.ts
import { MemoryEngine, ClaudeCliAdapter } from 'active-memory'

const engine = new MemoryEngine()

await engine.initialize({
  connection: 'ws://localhost:8000',
  namespace: 'production',
  database: 'memory',
  llm: new ClaudeCliAdapter(),
})

// Register domains...

export default engine
```

### What This Plan Does NOT Cover

- CLI implementation (Plan 5)
- Built-in domain implementations: User (Plan 3), Chat (Plan 4), Topic (Plan 2)
- Actual skill markdown file content for domains (written when domains are implemented)
- The `processInboxItem` being optional on DomainConfig (some domains like User won't process inbox — this will be addressed in the User domain plan)
