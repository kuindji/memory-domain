import type { CommandHandler, CommandResult } from '../types.ts'

const domainsCommand: CommandHandler = (engine, _parsed) => {
  const registry = engine.getDomainRegistry()
  const summaries = registry.listSummaries()
  return Promise.resolve({ output: summaries, exitCode: 0 })
}

const domainCommand: CommandHandler = (engine, parsed): Promise<CommandResult> => {
  const registry = engine.getDomainRegistry()
  const domainId = parsed.args[0]
  const subcommand = parsed.args[1]

  if (!domainId) {
    return Promise.resolve({ output: { error: 'Domain ID is required' }, exitCode: 1 })
  }

  const domain = registry.get(domainId)
  if (!domain) {
    return Promise.resolve({ output: { error: `Domain "${domainId}" not found` }, exitCode: 1 })
  }

  if (!subcommand) {
    return Promise.resolve({ output: { error: 'Subcommand is required: structure, skills, or skill <skill-id>' }, exitCode: 1 })
  }

  if (subcommand === 'structure') {
    if (!domain.structure) {
      return Promise.resolve({ output: { error: `Domain "${domainId}" has no structure defined` }, exitCode: 1 })
    }
    return Promise.resolve({
      output: { domainId, structure: domain.structure },
      exitCode: 0,
      formatCommand: 'domain-structure',
    })
  }

  if (subcommand === 'skills') {
    const skills = registry.getExternalSkills(domainId)
    return Promise.resolve({
      output: { domainId, skills },
      exitCode: 0,
      formatCommand: 'domain-skills',
    })
  }

  if (subcommand === 'skill') {
    const skillId = parsed.args[2]
    if (!skillId) {
      return Promise.resolve({ output: { error: 'Skill ID is required' }, exitCode: 1 })
    }
    const skill = registry.getSkill(domainId, skillId)
    if (!skill) {
      return Promise.resolve({ output: { error: `Skill "${skillId}" not found in domain "${domainId}"` }, exitCode: 1 })
    }
    return Promise.resolve({
      output: skill,
      exitCode: 0,
      formatCommand: 'domain-skill',
    })
  }

  return Promise.resolve({ output: { error: `Unknown subcommand "${subcommand}". Expected: structure, skills, or skill <skill-id>` }, exitCode: 1 })
}

export { domainsCommand, domainCommand }
