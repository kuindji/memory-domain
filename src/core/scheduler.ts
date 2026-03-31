import type { DomainSchedule, DomainContext, ScheduleInfo } from './types.ts'
import type { EventEmitter } from './events.ts'
import type { GraphApi } from './types.ts'

interface ScheduleStateStore {
  getLastRunAt(domainId: string, scheduleId: string): Promise<number>
  setLastRunAt(domainId: string, scheduleId: string, timestamp: number): Promise<void>
}

class MetaScheduleStateStore implements ScheduleStateStore {
  constructor(private graph: GraphApi) {}

  async getLastRunAt(domainId: string, scheduleId: string): Promise<number> {
    const metaId = `meta:_schedule_${domainId}_${scheduleId}`
    const node = await this.graph.getNode(metaId)
    if (!node) return 0
    const value = node.value
    return typeof value === 'string' ? parseInt(value, 10) || 0 : 0
  }

  async setLastRunAt(domainId: string, scheduleId: string, timestamp: number): Promise<void> {
    const metaId = `meta:_schedule_${domainId}_${scheduleId}`
    try {
      await this.graph.createNodeWithId(metaId, { value: String(timestamp) })
    } catch {
      await this.graph.updateNode(metaId, { value: String(timestamp) })
    }
  }
}

interface ScheduleEntry {
  domain: string
  schedule: DomainSchedule
  lastRunAt: number
}

class Scheduler {
  private entries = new Map<string, ScheduleEntry>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private contextFactory: (domainId: string, requestContext?: Record<string, unknown>) => DomainContext,
    private events?: EventEmitter,
    private stateStore?: ScheduleStateStore
  ) {}

  registerSchedule(domainId: string, schedule: DomainSchedule): void {
    const key = `${domainId}:${schedule.id}`
    this.entries.set(key, { domain: domainId, schedule, lastRunAt: 0 })
  }

  unregisterDomain(domainId: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${domainId}:`)) {
        this.entries.delete(key)
      }
    }
  }

  async tick(): Promise<void> {
    const now = Date.now()
    for (const [, entry] of this.entries) {
      const elapsed = now - entry.lastRunAt
      if (elapsed >= entry.schedule.intervalMs) {
        entry.lastRunAt = now
        try {
          const ctx = this.contextFactory(entry.domain)
          await entry.schedule.run(ctx)
          await this.stateStore?.setLastRunAt(entry.domain, entry.schedule.id, now)
          this.events?.emit('scheduleRun', { domainId: entry.domain, scheduleId: entry.schedule.id })
        } catch (err) {
          this.events?.emit('error', { source: 'scheduler', error: err })
        }
      }
    }
  }

  async tickPersisted(): Promise<{ ran: string[] }> {
    if (!this.stateStore) {
      throw new Error('No state store configured for persisted tick')
    }

    const now = Date.now()
    const ran: string[] = []

    for (const [key, entry] of this.entries) {
      const lastRun = await this.stateStore.getLastRunAt(entry.domain, entry.schedule.id)
      const elapsed = now - lastRun

      if (elapsed >= entry.schedule.intervalMs) {
        try {
          const ctx = this.contextFactory(entry.domain)
          await entry.schedule.run(ctx)
          await this.stateStore.setLastRunAt(entry.domain, entry.schedule.id, now)
          entry.lastRunAt = now
          ran.push(key)
          this.events?.emit('scheduleRun', { domainId: entry.domain, scheduleId: entry.schedule.id })
        } catch (err) {
          this.events?.emit('error', { source: 'scheduler', error: err })
        }
      }
    }

    return { ran }
  }

  start(tickIntervalMs = 60_000): void {
    this.stop()
    this.timer = setInterval(() => { void this.tick() }, tickIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  listSchedules(domainId?: string): ScheduleInfo[] {
    const result: ScheduleInfo[] = []
    for (const entry of this.entries.values()) {
      if (domainId !== undefined && entry.domain !== domainId) continue
      result.push({
        id: entry.schedule.id,
        domain: entry.domain,
        name: entry.schedule.name,
        interval: entry.schedule.intervalMs,
        lastRun: entry.lastRunAt > 0 ? entry.lastRunAt : undefined,
      })
    }
    return result
  }

  async listSchedulesPersisted(domainId?: string): Promise<ScheduleInfo[]> {
    const result: ScheduleInfo[] = []
    for (const entry of this.entries.values()) {
      if (domainId !== undefined && entry.domain !== domainId) continue
      const lastRun = this.stateStore
        ? await this.stateStore.getLastRunAt(entry.domain, entry.schedule.id)
        : (entry.lastRunAt > 0 ? entry.lastRunAt : undefined)
      result.push({
        id: entry.schedule.id,
        domain: entry.domain,
        name: entry.schedule.name,
        interval: entry.schedule.intervalMs,
        lastRun: lastRun || undefined,
      })
    }
    return result
  }

  async runNow(domainId: string, scheduleId?: string): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.domain === domainId && (!scheduleId || entry.schedule.id === scheduleId)) {
        const ctx = this.contextFactory(entry.domain)
        await entry.schedule.run(ctx)
      }
    }
  }
}

export { Scheduler, MetaScheduleStateStore }
export type { ScheduleStateStore }
