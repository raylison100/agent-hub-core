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
