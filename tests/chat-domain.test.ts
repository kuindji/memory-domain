import { describe, test, expect } from 'bun:test'
import { createChatDomain, chatDomain } from '../src/domains/chat/index.ts'
import {
  CHAT_DOMAIN_ID,
  DEFAULT_PROMOTE_INTERVAL_MS,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  DEFAULT_PRUNE_INTERVAL_MS,
} from '../src/domains/chat/types.ts'
describe('Chat domain - config', () => {
  test('has correct id and name', () => {
    const domain = createChatDomain()
    expect(domain.id).toBe('chat')
    expect(domain.name).toBe('Chat')
  })

  test('has baseDir and 3 skills', () => {
    const domain = createChatDomain()
    expect(domain.baseDir).toBeTypeOf('string')
    expect(domain.baseDir!.length).toBeGreaterThan(0)
    expect(domain.skills).toHaveLength(3)
    const skillIds = domain.skills!.map(s => s.id)
    expect(skillIds).toContain('chat-ingest')
    expect(skillIds).toContain('chat-query')
    expect(skillIds).toContain('chat-processing')
  })

  test('schema has 1 edge (summarizes)', () => {
    const domain = createChatDomain()
    const edges = domain.schema!.edges
    expect(edges).toHaveLength(1)
    expect(edges[0].name).toBe('summarizes')
    expect(edges[0].from).toBe('memory')
    expect(edges[0].to).toBe('memory')
  })

  test('default options include all three schedules', () => {
    const domain = createChatDomain()
    expect(domain.schedules).toHaveLength(3)
    const scheduleIds = domain.schedules!.map(s => s.id)
    expect(scheduleIds).toContain('promote-working-memory')
    expect(scheduleIds).toContain('consolidate-episodic')
    expect(scheduleIds).toContain('prune-decayed')
  })

  test('schedules use default intervals', () => {
    const domain = createChatDomain()
    const promote = domain.schedules!.find(s => s.id === 'promote-working-memory')!
    const consolidate = domain.schedules!.find(s => s.id === 'consolidate-episodic')!
    const prune = domain.schedules!.find(s => s.id === 'prune-decayed')!
    expect(promote.intervalMs).toBe(DEFAULT_PROMOTE_INTERVAL_MS)
    expect(consolidate.intervalMs).toBe(DEFAULT_CONSOLIDATE_INTERVAL_MS)
    expect(prune.intervalMs).toBe(DEFAULT_PRUNE_INTERVAL_MS)
  })

  test('individual schedules can be disabled', () => {
    const domain = createChatDomain({
      promoteSchedule: { enabled: false },
      consolidateSchedule: { enabled: false },
    })
    expect(domain.schedules).toHaveLength(1)
    expect(domain.schedules![0].id).toBe('prune-decayed')
  })

  test('schedules accept custom intervals', () => {
    const domain = createChatDomain({
      promoteSchedule: { intervalMs: 5000 },
    })
    const promote = domain.schedules!.find(s => s.id === 'promote-working-memory')!
    expect(promote.intervalMs).toBe(5000)
  })

  test('describe() returns a non-empty string', () => {
    const domain = createChatDomain()
    const describeFn = domain.describe?.bind(domain)
    expect(describeFn).toBeTypeOf('function')
    expect(describeFn!().length).toBeGreaterThan(0)
  })

  test('default chatDomain instance is valid', () => {
    expect(chatDomain.id).toBe(CHAT_DOMAIN_ID)
    expect(chatDomain.schedules).toHaveLength(3)
  })
})
