import { existsSync } from 'fs'
import { join, isAbsolute } from 'path'
import type { MemoryEngine } from './core/engine.ts'

const CONFIG_NAMES = [
  'memory-domain.config.ts',
  'memory-domain.config.js',
  'memory-domain.config.mjs',
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
      `No memory-domain config file found in ${dir}. ` +
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
