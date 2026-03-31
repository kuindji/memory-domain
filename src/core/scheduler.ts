import type { DomainSchedule, DomainContext, ScheduleInfo } from './types.ts'
import type { EventEmitter } from './events.ts'

interface ScheduleEntry {
  domain: string
  schedule: DomainSchedule
  lastRunAt: number
}

export class Scheduler {
  private entries = new Map<string, ScheduleEntry>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private contextFactory: (domainId: string, requestContext?: Record<string, unknown>) => DomainContext,
    private events?: EventEmitter
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
          this.events?.emit('scheduleRun', { domainId: entry.domain, scheduleId: entry.schedule.id })
        } catch (err) {
          this.events?.emit('error', { source: 'scheduler', error: err })
        }
      }
    }
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

  async runNow(domainId: string, scheduleId?: string): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.domain === domainId && (!scheduleId || entry.schedule.id === scheduleId)) {
        const ctx = this.contextFactory(entry.domain)
        await entry.schedule.run(ctx)
      }
    }
  }
}
