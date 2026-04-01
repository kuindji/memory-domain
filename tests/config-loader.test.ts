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

  test('resolveConfigPath finds memory-domain.config.ts', () => {
    writeFileSync(join(tmpDir, 'memory-domain.config.ts'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'memory-domain.config.ts'))
  })

  test('resolveConfigPath finds memory-domain.config.js', () => {
    writeFileSync(join(tmpDir, 'memory-domain.config.js'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'memory-domain.config.js'))
  })

  test('resolveConfigPath finds memory-domain.config.mjs', () => {
    writeFileSync(join(tmpDir, 'memory-domain.config.mjs'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'memory-domain.config.mjs'))
  })

  test('resolveConfigPath prefers .ts over .js', () => {
    writeFileSync(join(tmpDir, 'memory-domain.config.ts'), 'export default {}')
    writeFileSync(join(tmpDir, 'memory-domain.config.js'), 'export default {}')
    const result = resolveConfigPath(tmpDir)
    expect(result).toBe(join(tmpDir, 'memory-domain.config.ts'))
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
