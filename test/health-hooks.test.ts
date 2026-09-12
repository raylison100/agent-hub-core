import { describe, expect, it } from 'vitest'
import { hookCatalog } from '../src/hooks/catalog.js'
import { HookConfigSchema } from '../src/hooks/runner.js'

describe('catalogo de ganchos', () => {
  it('todo gancho do catalogo passa no schema e tem id unico', () => {
    const ids = new Set<string>()
    for (const item of hookCatalog) {
      expect(() => HookConfigSchema.parse(item.hook)).not.toThrow()
      expect(ids.has(item.id)).toBe(false)
      ids.add(item.id)
      expect(item.detail.length).toBeGreaterThan(20)
    }
  })

  it('o gancho de comando destrutivo barra antes de executar', () => {
    const barrar = hookCatalog.find((h) => h.id === 'bloquear-comando-perigoso')!
    expect(barrar.hook.event).toBe('tool.before')
    expect(barrar.hook.match.tool).toBe('run_command')
  })
})
