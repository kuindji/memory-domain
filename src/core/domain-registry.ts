import type { DomainConfig, DomainSkill, DomainSummary } from './types.ts'

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
