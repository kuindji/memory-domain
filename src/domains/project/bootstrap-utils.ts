import type { DirEntry, AnalysisResult, AnalysisModule, AnalysisRelationship } from './types.ts'

const MAX_FILES_SHOWN = 30

function formatTree(entries: DirEntry[], indent: string, depth = 0, maxDepth = 6): string {
  if (depth >= maxDepth) return ''
  const lines: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    const files = entry.files ?? []
    let fileInfo = ''
    if (files.length > 0) {
      const shown = files.slice(0, MAX_FILES_SHOWN)
      const suffix = files.length > MAX_FILES_SHOWN
        ? `, ... and ${files.length - MAX_FILES_SHOWN} more`
        : ''
      fileInfo = ` [${shown.join(', ')}${suffix}]`
    }
    lines.push(`${indent}${entry.name}/${fileInfo}`)
    if (entry.children?.length) {
      const childText = formatTree(entry.children, indent + '  ', depth + 1, maxDepth)
      if (childText) lines.push(childText)
    }
  }
  return lines.join('\n')
}

function countDirectories(entries: DirEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory) {
      count++
      if (entry.children) {
        count += countDirectories(entry.children)
      }
    }
  }
  return count
}

function calculateScanDepth(dirCount: number): number {
  if (dirCount > 100) return 3
  if (dirCount >= 20) return 4
  return 6
}

interface ValidationResult {
  analysis: AnalysisResult
  warnings: string[]
}

const GENERIC_MODULE_NAMES = new Set([
  'utils', 'helpers', 'common', 'misc', 'shared', 'lib', 'core', 'types', 'config',
])

function normalizeModuleName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

function validateAnalysisResult(analysis: AnalysisResult): ValidationResult {
  const warnings: string[] = []

  // Modules: filter, deduplicate, normalize
  const seenModuleNames = new Map<string, string>()
  const modules: AnalysisModule[] = []
  for (const mod of analysis.modules ?? []) {
    if (!mod.name) continue
    if (!mod.path) {
      warnings.push(`Filtered module "${mod.name}" with no path`)
      continue
    }
    const normalized = normalizeModuleName(mod.name)
    if (seenModuleNames.has(normalized)) {
      warnings.push(`Filtered duplicate module "${mod.name}"`)
      continue
    }
    seenModuleNames.set(normalized, mod.name)
    if (GENERIC_MODULE_NAMES.has(normalized)) {
      warnings.push(`Suspiciously generic module name: "${normalized}"`)
    }
    modules.push({ ...mod, name: normalized })
  }

  // Data entities: deduplicate
  const seenEntities = new Set<string>()
  const dataEntities = (analysis.data_entities ?? []).filter(e => {
    if (!e.name) return false
    if (seenEntities.has(e.name)) return false
    seenEntities.add(e.name)
    return true
  })

  // Concepts: deduplicate
  const seenConcepts = new Set<string>()
  const concepts = (analysis.concepts ?? []).filter(c => {
    if (!c.name) return false
    if (seenConcepts.has(c.name)) return false
    seenConcepts.add(c.name)
    return true
  })

  // Patterns: deduplicate
  const seenPatterns = new Set<string>()
  const patterns = (analysis.patterns ?? []).filter(p => {
    if (!p.name) return false
    if (seenPatterns.has(p.name)) return false
    seenPatterns.add(p.name)
    return true
  })

  // Relationships: validate, normalize, filter
  const moduleNames = new Set(modules.map(m => m.name))
  const conceptNames = new Set(concepts.map(c => c.name))
  const relationships: AnalysisRelationship[] = []

  for (const rel of analysis.relationships ?? []) {
    const from = normalizeModuleName(rel.from)
    const to = rel.type === 'implements' ? rel.to : normalizeModuleName(rel.to)

    if (from === to) {
      warnings.push(`Filtered self-relationship: "${rel.from}"`)
      continue
    }

    if (rel.type === 'implements') {
      if (!moduleNames.has(from)) {
        warnings.push(`Filtered implements relationship: non-existent module "${rel.from}"`)
        continue
      }
      if (!conceptNames.has(to)) {
        warnings.push(`Filtered implements relationship: non-existent concept "${rel.to}"`)
        continue
      }
    } else {
      if (!moduleNames.has(from) || !moduleNames.has(to)) {
        warnings.push(`Filtered relationship "${rel.from}" → "${rel.to}": non-existent module`)
        continue
      }
    }

    relationships.push({ ...rel, from, to })
  }

  return {
    analysis: {
      modules,
      data_entities: dataEntities,
      concepts,
      patterns,
      relationships,
    },
    warnings,
  }
}

export { formatTree, countDirectories, calculateScanDepth, validateAnalysisResult }
export type { ValidationResult }
