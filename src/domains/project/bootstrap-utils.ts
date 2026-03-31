import type { DirEntry } from './types.ts'

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

export { formatTree, countDirectories, calculateScanDepth }
