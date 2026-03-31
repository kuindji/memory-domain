import { describe, test, expect } from 'bun:test'
import { formatTree, countDirectories, calculateScanDepth, validateAnalysisResult } from '../src/domains/project/bootstrap-utils.ts'
import type { DirEntry, AnalysisResult } from '../src/domains/project/types.ts'

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

describe('validateAnalysisResult', () => {
  test('filters self-relationships', () => {
    const input: AnalysisResult = {
      modules: [{ name: 'core', path: 'src/core', kind: 'subsystem' }],
      relationships: [{ from: 'core', to: 'core', type: 'contains' }],
    }
    const { analysis, warnings } = validateAnalysisResult(input)
    expect(analysis.relationships).toHaveLength(0)
    expect(warnings.some(w => w.includes('self-relationship'))).toBe(true)
  })

  test('filters duplicate modules by normalized name', () => {
    const input: AnalysisResult = {
      modules: [
        { name: 'Core', path: 'src/core', kind: 'subsystem' },
        { name: 'core', path: 'src/core2', kind: 'subsystem' },
      ],
    }
    const { analysis, warnings } = validateAnalysisResult(input)
    expect(analysis.modules).toHaveLength(1)
    expect(warnings.some(w => w.includes('duplicate'))).toBe(true)
  })

  test('filters modules with empty path', () => {
    const input: AnalysisResult = {
      modules: [
        { name: 'good', path: 'src/good', kind: 'subsystem' },
        { name: 'bad', path: '', kind: 'subsystem' },
      ],
    }
    const { analysis } = validateAnalysisResult(input)
    expect(analysis.modules).toHaveLength(1)
    expect(analysis.modules![0].name).toBe('good')
  })

  test('normalizes module names to lowercase hyphenated', () => {
    const input: AnalysisResult = {
      modules: [
        { name: 'OrderProcessor', path: 'src/order', kind: 'service' },
        { name: 'payment_service', path: 'src/payment', kind: 'service' },
      ],
    }
    const { analysis } = validateAnalysisResult(input)
    expect(analysis.modules![0].name).toBe('order-processor')
    expect(analysis.modules![1].name).toBe('payment-service')
  })

  test('filters relationships referencing non-existent modules', () => {
    const input: AnalysisResult = {
      modules: [{ name: 'core', path: 'src/core', kind: 'subsystem' }],
      relationships: [{ from: 'core', to: 'nonexistent', type: 'connects_to' }],
    }
    const { analysis, warnings } = validateAnalysisResult(input)
    expect(analysis.relationships).toHaveLength(0)
    expect(warnings.some(w => w.includes('non-existent'))).toBe(true)
  })

  test('validates implements relationships against concepts', () => {
    const input: AnalysisResult = {
      modules: [{ name: 'billing', path: 'src/billing', kind: 'service' }],
      concepts: [{ name: 'payment-processing' }],
      relationships: [
        { from: 'billing', to: 'payment-processing', type: 'implements' },
        { from: 'billing', to: 'nonexistent-concept', type: 'implements' },
      ],
    }
    const { analysis } = validateAnalysisResult(input)
    expect(analysis.relationships).toHaveLength(1)
    expect(analysis.relationships![0].to).toBe('payment-processing')
  })

  test('normalizes relationship names to match normalized module names', () => {
    const input: AnalysisResult = {
      modules: [
        { name: 'OrderProcessor', path: 'src/order', kind: 'service' },
        { name: 'PaymentService', path: 'src/payment', kind: 'service' },
      ],
      relationships: [
        { from: 'OrderProcessor', to: 'PaymentService', type: 'connects_to' },
      ],
    }
    const { analysis } = validateAnalysisResult(input)
    expect(analysis.relationships).toHaveLength(1)
    expect(analysis.relationships![0].from).toBe('order-processor')
    expect(analysis.relationships![0].to).toBe('payment-service')
  })

  test('deduplicates data_entities by name', () => {
    const input: AnalysisResult = {
      data_entities: [
        { name: 'Order', source: 'a.ts' },
        { name: 'Order', source: 'b.ts' },
      ],
    }
    const { analysis } = validateAnalysisResult(input)
    expect(analysis.data_entities).toHaveLength(1)
  })

  test('warns on generic module names', () => {
    const input: AnalysisResult = {
      modules: [
        { name: 'utils', path: 'src/utils', kind: 'library' },
        { name: 'api-gateway', path: 'src/api', kind: 'service' },
      ],
    }
    const { warnings } = validateAnalysisResult(input)
    expect(warnings.some(w => w.includes('generic') && w.includes('utils'))).toBe(true)
    expect(warnings.some(w => w.includes('api-gateway'))).toBe(false)
  })

  test('handles empty/undefined input gracefully', () => {
    const { analysis, warnings } = validateAnalysisResult({})
    expect(analysis.modules ?? []).toHaveLength(0)
    expect(analysis.relationships ?? []).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })
})
