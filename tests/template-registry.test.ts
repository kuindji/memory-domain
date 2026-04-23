import { describe, it, expect } from 'bun:test'
import type { DomainConfig, TemplateResult, TemplateFn } from '../src/index.ts'

describe('template registry types', () => {
  it('TemplateResult has rows, columns, source, narrative?', () => {
    const r: TemplateResult = {
      template: 'macro_snapshot',
      rows: [{ country: 'USA', indicator_code: 'NY.GDP.MKTP.KD.ZG', year: 2008, value: -2.5 }],
      columns: ['country', 'indicator_code', 'year', 'value'],
      source: 'wdi',
    }
    expect(r.template).toBe('macro_snapshot')
    expect(r.rows.length).toBe(1)
    expect(r.narrative).toBeUndefined()
  })

  it('DomainConfig.buildContext accepts { fromText, templates } shape', () => {
    const template: TemplateFn = async () => ({
      template: 't', rows: [], columns: ['a'], source: 'x',
    })
    const cfg: Partial<DomainConfig> = {
      buildContext: {
        fromText: async () => ({ context: '', memories: [], totalTokens: 0 }),
        templates: { t: template },
      },
    }
    expect(cfg.buildContext).toBeDefined()
  })

  it('DomainConfig.buildContext still accepts legacy function shape', () => {
    const cfg: Partial<DomainConfig> = {
      buildContext: async () => ({ context: '', memories: [], totalTokens: 0 }),
    }
    expect(cfg.buildContext).toBeDefined()
  })
})
