import type { DomainConfig } from './types.ts'

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
}
