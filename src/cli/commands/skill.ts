import type { CommandHandler } from '../types.ts'

const skillCommand: CommandHandler = async (engine, _parsed) => {
  const registry = engine.getDomainRegistry()
  const domains = registry.list()

  const sections: string[] = []

  for (const domain of domains) {
    const skills = registry.getExternalSkills(domain.id)
    if (skills.length === 0) continue

    for (const skill of skills) {
      const content = await registry.getSkillContent(domain.id, skill.id)
      if (content) {
        sections.push(content)
      }
    }
  }

  const combined = sections.join('\n\n---\n\n')

  return {
    output: { content: combined },
    exitCode: 0,
    formatCommand: 'skill',
  }
}

export { skillCommand }
