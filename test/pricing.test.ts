import { describe, expect, it } from 'vitest'
import { Pricing, PricingMissingError } from '../src/cost/pricing.js'

const pricing = new Pricing({
  version: 'teste',
  models: {
    'anthropic/claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    'deepseek/deepseek-chat': { input: null, output: null },
    'ollama/*': { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
})

describe('Pricing', () => {
  it('calcula custo por milhao com cache', () => {
    const cost = pricing.cost('anthropic', 'claude-opus-5', {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 2_000_000,
      cacheWrite: 400_000,
      reasoning: 0,
      missing: false,
    })
    expect(cost).toBeCloseTo(5 + 2.5 + 1 + 2.5, 6)
  })

  it('usa curinga do provedor', () => {
    expect(pricing.cost('ollama', 'qwen3:14b', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false })).toBe(0)
  })

  it('falha com preco nulo em vez de assumir zero', () => {
    expect(() =>
      pricing.cost('deepseek', 'deepseek-chat', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false }),
    ).toThrow(PricingMissingError)
  })

  it('falha com modelo desconhecido', () => {
    expect(() => pricing.resolve('openai', 'gpt-x')).toThrow(PricingMissingError)
  })
})

describe('desconto fora de pico', () => {
  const tabela = new Pricing({
    version: 'teste',
    models: { 'deepseek/deepseek-v4-flash': { input: 0.44, output: 1.32, cache_read: 0.014, cache_write: 0 } },
    time_discounts: {
      'deepseek/*': { multiplier: 0.5, peak_utc: { weekdays_only: true, ranges: [['01:00', '04:00'], ['06:00', '10:00']] } },
    },
  })
  const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false }
  const segundaPico = new Date('2026-09-07T02:30:00Z')
  const segundaForaDePico = new Date('2026-09-07T12:00:00Z')
  const domingo = new Date('2026-09-06T02:30:00Z')

  it('cobra cheio dentro da janela de pico em dia util', () => {
    expect(tabela.multiplierAt('deepseek', 'deepseek-v4-flash', segundaPico)).toBe(1)
    expect(tabela.cost('deepseek', 'deepseek-v4-flash', usage, segundaPico)).toBeCloseTo(0.44, 6)
  })

  it('cobra metade fora da janela e no fim de semana', () => {
    expect(tabela.multiplierAt('deepseek', 'deepseek-v4-flash', segundaForaDePico)).toBe(0.5)
    expect(tabela.cost('deepseek', 'deepseek-v4-flash', usage, segundaForaDePico)).toBeCloseTo(0.22, 6)
    expect(tabela.multiplierAt('deepseek', 'deepseek-v4-flash', domingo)).toBe(0.5)
  })

  it('borda da janela: comeco conta como pico, fim nao', () => {
    expect(tabela.multiplierAt('deepseek', 'deepseek-v4-flash', new Date('2026-09-07T01:00:00Z'))).toBe(1)
    expect(tabela.multiplierAt('deepseek', 'deepseek-v4-flash', new Date('2026-09-07T04:00:00Z'))).toBe(0.5)
  })

  it('preco efetivo escala todos os campos', () => {
    const p = tabela.effective('deepseek', 'deepseek-v4-flash', segundaForaDePico)
    expect(p.input).toBeCloseTo(0.22, 6)
    expect(p.output).toBeCloseTo(0.66, 6)
    expect(p.cache_read).toBeCloseTo(0.007, 6)
  })

  it('provedor sem desconto segue em 1', () => {
    expect(pricing.multiplierAt('anthropic', 'claude-opus-5', segundaForaDePico)).toBe(1)
  })
})
