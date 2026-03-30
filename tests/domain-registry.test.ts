import { describe, test, expect } from 'bun:test'
import { DomainRegistry } from '../src/core/domain-registry.ts'
import type { DomainConfig } from '../src/core/types.ts'

function makeDomain(id: string, name?: string): DomainConfig {
  return {
    id,
    name: name ?? id,
    async processInboxItem() {},
  }
}

describe('DomainRegistry', () => {
  test('register and get a domain', () => {
    const registry = new DomainRegistry()
    const domain = makeDomain('test')
    registry.register(domain)

    expect(registry.get('test')).toBe(domain)
  })

  test('get returns undefined for unknown domain', () => {
    const registry = new DomainRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  test('getOrThrow returns the domain', () => {
    const registry = new DomainRegistry()
    const domain = makeDomain('test')
    registry.register(domain)

    expect(registry.getOrThrow('test')).toBe(domain)
  })

  test('getOrThrow throws for unknown domain', () => {
    const registry = new DomainRegistry()
    expect(() => registry.getOrThrow('missing')).toThrow('Domain "missing" not found')
  })

  test('has returns true for registered domain', () => {
    const registry = new DomainRegistry()
    registry.register(makeDomain('test'))
    expect(registry.has('test')).toBe(true)
  })

  test('has returns false for unknown domain', () => {
    const registry = new DomainRegistry()
    expect(registry.has('test')).toBe(false)
  })

  test('list returns all registered domains', () => {
    const registry = new DomainRegistry()
    const a = makeDomain('a')
    const b = makeDomain('b')
    registry.register(a)
    registry.register(b)

    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list).toContain(a)
    expect(list).toContain(b)
  })

  test('getAllDomainIds returns all ids', () => {
    const registry = new DomainRegistry()
    registry.register(makeDomain('x'))
    registry.register(makeDomain('y'))

    const ids = registry.getAllDomainIds()
    expect(ids).toContain('x')
    expect(ids).toContain('y')
    expect(ids).toHaveLength(2)
  })

  test('duplicate registration throws', () => {
    const registry = new DomainRegistry()
    registry.register(makeDomain('dup'))

    expect(() => registry.register(makeDomain('dup'))).toThrow(
      'Domain "dup" is already registered'
    )
  })

  test('unregister removes a domain', () => {
    const registry = new DomainRegistry()
    registry.register(makeDomain('removable'))
    expect(registry.has('removable')).toBe(true)

    registry.unregister('removable')
    expect(registry.has('removable')).toBe(false)
    expect(registry.get('removable')).toBeUndefined()
  })

  test('unregister log domain throws', () => {
    const registry = new DomainRegistry()
    registry.register(makeDomain('log'))

    expect(() => registry.unregister('log')).toThrow(
      'Cannot unregister the built-in log domain'
    )
  })

  test('unregister non-existent domain is a no-op', () => {
    const registry = new DomainRegistry()
    // Should not throw
    registry.unregister('ghost')
    expect(registry.has('ghost')).toBe(false)
  })

  test('domain with baseDir is accepted', () => {
    const registry = new DomainRegistry()
    const domain: DomainConfig = {
      id: 'typed',
      name: 'Typed Domain',
      baseDir: '/some/path',
      async processInboxItem() {},
    }
    registry.register(domain)
    expect(registry.get('typed')?.baseDir).toBe('/some/path')
  })
})
