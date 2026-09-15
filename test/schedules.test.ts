import { describe, expect, it } from 'vitest'
import { ScheduleSchema } from '../src/agents/schema.js'

const base = {
  id: 'ideias-do-dia',
  cron: '0 11 * * *',
  agent: 'gemini',
  workspace: '/tmp',
  prompt: 'Proponha ideias',
  budget: { run_usd: 1, day_usd: 2 },
}

describe('ScheduleSchema', () => {
  it('sem papel e sem canais continua valido', () => {
    const spec = ScheduleSchema.parse(base)
    expect(spec.role).toBeUndefined()
    expect(spec.notify).toEqual([])
  })

  it('aceita papel e aviso no telegram', () => {
    const spec = ScheduleSchema.parse({ ...base, role: 'social-media', notify: ['telegram'] })
    expect(spec.role).toBe('social-media')
    expect(spec.notify).toEqual(['telegram'])
  })

  it('recusa canal desconhecido', () => {
    expect(() => ScheduleSchema.parse({ ...base, notify: ['fax'] })).toThrow()
  })
})
