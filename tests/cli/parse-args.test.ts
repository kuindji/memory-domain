import { describe, it, expect } from 'bun:test'
import { parseArgs } from '../../src/cli/parse-args.ts'

describe('parseArgs', () => {
  it('returns help command when no args provided', () => {
    const result = parseArgs([])
    expect(result.command).toBe('help')
    expect(result.args).toEqual([])
  })

  it('parses command name', () => {
    const result = parseArgs(['ingest'])
    expect(result.command).toBe('ingest')
    expect(result.args).toEqual([])
  })

  it('parses positional args after command', () => {
    const result = parseArgs(['search', 'my query'])
    expect(result.command).toBe('search')
    expect(result.args).toEqual(['my query'])
  })

  it('parses multiple positional args', () => {
    const result = parseArgs(['domain', 'add', 'myDomain'])
    expect(result.command).toBe('domain')
    expect(result.args).toEqual(['add', 'myDomain'])
  })

  it('parses --key value flags', () => {
    const result = parseArgs(['search', 'query', '--config', '/path/to/config'])
    expect(result.flags['config']).toBe('/path/to/config')
  })

  it('parses --key=value flags', () => {
    const result = parseArgs(['search', 'query', '--config=/path/to/config'])
    expect(result.flags['config']).toBe('/path/to/config')
  })

  it('parses boolean flag --json', () => {
    const result = parseArgs(['search', 'query', '--json'])
    expect(result.flags.json).toBe(true)
  })

  it('parses boolean flag --skip-dedup', () => {
    const result = parseArgs(['ingest', '--skip-dedup'])
    expect(result.flags['skip-dedup']).toBe(true)
  })

  it('--help anywhere triggers help command', () => {
    const result = parseArgs(['search', '--help'])
    expect(result.command).toBe('help')
  })

  it('--help at start triggers help command', () => {
    const result = parseArgs(['--help'])
    expect(result.command).toBe('help')
  })

  it('--help in the middle triggers help command', () => {
    const result = parseArgs(['search', 'my query', '--help', '--json'])
    expect(result.command).toBe('help')
  })

  it('comma-separated values stay as single string', () => {
    const result = parseArgs(['search', 'query', '--domains', 'd1,d2,d3'])
    expect(result.flags['domains']).toBe('d1,d2,d3')
  })

  it('comma-separated values via --key=value stay as single string', () => {
    const result = parseArgs(['search', 'query', '--domains=d1,d2,d3'])
    expect(result.flags['domains']).toBe('d1,d2,d3')
  })

  it('handles mixed flags and positional args', () => {
    const result = parseArgs(['ingest', '--json', 'some-file.txt', '--cwd', '/workspace'])
    expect(result.command).toBe('ingest')
    expect(result.args).toEqual(['some-file.txt'])
    expect(result.flags.json).toBe(true)
    expect(result.flags['cwd']).toBe('/workspace')
  })

  it('unknown flags pass through in flags record', () => {
    const result = parseArgs(['search', 'query', '--limit', '10'])
    expect(result.flags['limit']).toBe('10')
  })

  it('flags before command are parsed correctly', () => {
    const result = parseArgs(['--config', '/path/config', 'search', 'query'])
    expect(result.command).toBe('search')
    expect(result.args).toEqual(['query'])
    expect(result.flags['config']).toBe('/path/config')
  })

  it('json flag defaults to false', () => {
    const result = parseArgs(['search'])
    expect(result.flags.json).toBe(false)
  })
})
