import { describe, test, expect } from 'bun:test'
import { formatTree, countDirectories, calculateScanDepth } from '../src/domains/project/bootstrap-utils.ts'
import type { DirEntry } from '../src/domains/project/types.ts'

function makeDir(name: string, files: string[] = [], children: DirEntry[] = []): DirEntry {
  return { name, relativePath: name, isDirectory: true, files, children }
}

describe('formatTree', () => {
  test('shows all files when under cap', () => {
    const tree = [makeDir('src', ['index.ts', 'main.ts', 'types.ts'])]
    const result = formatTree(tree, '')
    expect(result).toContain('index.ts')
    expect(result).toContain('main.ts')
    expect(result).toContain('types.ts')
    expect(result).not.toContain('more')
  })

  test('caps files at 30 with overflow indicator', () => {
    const files = Array.from({ length: 40 }, (_, i) => `file${i}.ts`)
    const tree = [makeDir('src', files)]
    const result = formatTree(tree, '')
    expect(result).toContain('file0.ts')
    expect(result).toContain('file29.ts')
    expect(result).not.toContain('file30.ts')
    expect(result).toContain('... and 10 more')
  })

  test('exactly 30 files shows all, no overflow', () => {
    const files = Array.from({ length: 30 }, (_, i) => `file${i}.ts`)
    const tree = [makeDir('src', files)]
    const result = formatTree(tree, '')
    expect(result).toContain('file29.ts')
    expect(result).not.toContain('more')
  })

  test('nested directories render with indent', () => {
    const tree = [makeDir('src', ['index.ts'], [makeDir('core', ['engine.ts'])])]
    const result = formatTree(tree, '')
    expect(result).toContain('src/')
    expect(result).toContain('  core/')
    expect(result).toContain('engine.ts')
  })

  test('respects maxDepth parameter', () => {
    const tree = [makeDir('src', [], [makeDir('core', [], [makeDir('deep', ['file.ts'])])])]
    const shallow = formatTree(tree, '', 0, 1)
    expect(shallow).toContain('src/')
    expect(shallow).not.toContain('core/')

    const medium = formatTree(tree, '', 0, 2)
    expect(medium).toContain('core/')
    expect(medium).not.toContain('deep/')
  })

  test('empty directory shows no file annotation', () => {
    const tree = [makeDir('empty')]
    const result = formatTree(tree, '')
    expect(result).toBe('empty/')
  })
})

describe('countDirectories', () => {
  test('counts nested directories', () => {
    const tree = [
      makeDir('src', [], [makeDir('core'), makeDir('utils')]),
      makeDir('tests'),
    ]
    expect(countDirectories(tree)).toBe(4)
  })

  test('returns 0 for empty', () => {
    expect(countDirectories([])).toBe(0)
  })
})

describe('calculateScanDepth', () => {
  test('small repo gets depth 6', () => {
    expect(calculateScanDepth(10)).toBe(6)
    expect(calculateScanDepth(0)).toBe(6)
    expect(calculateScanDepth(19)).toBe(6)
  })

  test('medium repo gets depth 4', () => {
    expect(calculateScanDepth(20)).toBe(4)
    expect(calculateScanDepth(50)).toBe(4)
    expect(calculateScanDepth(100)).toBe(4)
  })

  test('large repo gets depth 3', () => {
    expect(calculateScanDepth(101)).toBe(3)
    expect(calculateScanDepth(500)).toBe(3)
  })
})
