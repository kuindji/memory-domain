import type { CommandHandler } from '../types.ts'
import type { UpdateOptions } from '../../core/types.ts'

const memoryCommand: CommandHandler = async (engine, parsed) => {
  const [id, subcommand, subArg] = parsed.args

  if (!id) return { output: { error: 'Memory id is required' }, exitCode: 1 }

  if (!subcommand) {
    const mem = await engine.getMemory(id)
    if (!mem) return { output: { error: `Memory not found: ${id}` }, exitCode: 1 }
    const tags = await engine.getMemoryTags(id)
    return { output: { ...mem, tags }, exitCode: 0 }
  }

  if (subcommand === 'update') {
    const text = parsed.flags['text'] as string | undefined
    const attr = parsed.flags['attr']
    const attributes = attr && typeof attr === 'object' ? (attr as Record<string, unknown>) : undefined

    if (!text && !attributes) {
      return { output: { error: '--text or --attr is required for update' }, exitCode: 1 }
    }

    const options: UpdateOptions = {}
    if (text) options.text = text
    if (attributes) options.attributes = attributes

    try {
      await engine.updateMemory(id, options)
      const updated = await engine.getMemory(id)
      return { output: updated, exitCode: 0 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: { error: message }, exitCode: 1 }
    }
  }

  if (subcommand === 'tags') {
    const tags = await engine.getMemoryTags(id)
    return { output: { tags }, exitCode: 0 }
  }

  if (subcommand === 'tag') {
    if (!subArg) return { output: { error: 'Tag name is required' }, exitCode: 1 }
    await engine.tagMemory(id, subArg)
    const tags = await engine.getMemoryTags(id)
    return { output: { tags }, exitCode: 0 }
  }

  if (subcommand === 'untag') {
    if (!subArg) return { output: { error: 'Tag name is required' }, exitCode: 1 }
    await engine.untagMemory(id, subArg)
    const tags = await engine.getMemoryTags(id)
    return { output: { tags }, exitCode: 0 }
  }

  if (subcommand === 'release') {
    const domain = parsed.flags['domain'] as string | undefined
    if (!domain) return { output: { error: '--domain is required for release' }, exitCode: 1 }
    try {
      await engine.releaseOwnership(id, domain)
      return { output: { released: true }, exitCode: 0 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: { error: message }, exitCode: 1 }
    }
  }

  if (subcommand === 'delete') {
    try {
      await engine.deleteMemory(id)
      return { output: { deleted: true }, exitCode: 0 }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: { error: message }, exitCode: 1 }
    }
  }

  return { output: { error: `Unknown subcommand: ${subcommand}` }, exitCode: 1 }
}

export { memoryCommand }
