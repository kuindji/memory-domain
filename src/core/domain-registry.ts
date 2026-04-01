import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DomainConfig, DomainSkill, DomainSummary, DomainRegistrationOptions } from './types.ts'

export class DomainRegistry {
  private domains = new Map<string, DomainConfig>()
  private accessLevels = new Map<string, 'read' | 'write'>()

  register(domain: DomainConfig, options?: DomainRegistrationOptions): void {
    if (this.domains.has(domain.id)) {
      throw new Error(`Domain "${domain.id}" is already registered`)
    }
    this.domains.set(domain.id, domain)
    this.accessLevels.set(domain.id, options?.access ?? 'write')
  }

  unregister(domainId: string): void {
    this.domains.delete(domainId)
    this.accessLevels.delete(domainId)
  }

  getAccess(domainId: string): 'read' | 'write' {
    const access = this.accessLevels.get(domainId)
    if (access === undefined) throw new Error(`Domain "${domainId}" not found`)
    return access
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
    const isReadOnly = this.accessLevels.get(domainId) === 'read'
    return domain.skills.filter(s => {
      const isExternal = s.scope === 'external' || s.scope === 'both'
      if (!isExternal) return false
      if (isReadOnly && s.writes) return false
      return true
    })
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

  async getStructure(domainId: string): Promise<string | null> {
    const domain = this.domains.get(domainId)
    if (!domain?.baseDir) return null
    try {
      return await readFile(join(domain.baseDir, 'structure.md'), 'utf-8')
    } catch {
      return null
    }
  }

  async getSkillContent(domainId: string, skillId: string): Promise<string | null> {
    const domain = this.domains.get(domainId)
    if (!domain?.baseDir) return null
    try {
      return await readFile(join(domain.baseDir, 'skills', `${skillId}.md`), 'utf-8')
    } catch {
      return null
    }
  }

  listSummaries(): DomainSummary[] {
    return this.list().map(d => ({
      id: d.id,
      name: d.name,
      description: d.describe?.(),
      hasStructure: d.baseDir != null && existsSync(join(d.baseDir, 'structure.md')),
      skillCount: d.skills?.length ?? 0,
    }))
  }
}
