import { describe, expect, it } from 'vitest'
import { ScoringSchema, blendedCost, scoreAgents, type ScoreCandidate } from '../src/agents/scoring.js'
import type { ModelPrice } from '../src/cost/pricing.js'

const prices: Record<string, ModelPrice> = {
  'anthropic/opus': { input: 5, output: 25 },
  'deepseek/flash': { input: 0.44, output: 1.32 },
  'ollama/qwen': { input: 0, output: 0 },
  'openai/terra': { input: 2, output: 12 },
}

const priceOf = (provider: string, model: string) => prices[`${provider}/${model}`] ?? null

function candidate(over: Partial<ScoreCandidate> & { name: string; provider: string; model: string }): ScoreCandidate {
  return { capabilities: { '*': 0.7 }, contextWindow: 128000, maxOutput: 8000, ...over }
}

const scoring = ScoringSchema.parse({})

describe('blendedCost', () => {
  it('pondera 70% entrada e 30% saida', () => {
    expect(blendedCost({ input: 10, output: 20 })).toBe(13)
  })
  it('devolve null quando falta preco', () => {
    expect(blendedCost({ input: 10, output: null })).toBeNull()
  })
})

describe('scoreAgents', () => {
  const base = [
    candidate({ name: 'caro', provider: 'anthropic', model: 'opus', capabilities: { '*': 0.85, implementar: 0.85 } }),
    candidate({ name: 'barato', provider: 'deepseek', model: 'flash', capabilities: { '*': 0.7, implementar: 0.8 } }),
    candidate({ name: 'gratis', provider: 'ollama', model: 'qwen', capabilities: { '*': 0.35, explicar: 0.65 }, contextWindow: 8192, maxOutput: 4000, maxPromptTokens: 2500 }),
  ]

  it('capacidade proxima com custo menor vence', () => {
    const r = scoreAgents(base, priceOf, scoring, { intent: 'implementar', promptTokens: 100 })
    expect(r.chosen?.agent).toBe('barato')
    expect(r.ranking[0].agent).toBe('barato')
  })

  it('modelo gratis vence a intencao em que e capaz', () => {
    const r = scoreAgents(base, priceOf, scoring, { intent: 'explicar', promptTokens: 100 })
    expect(r.chosen?.agent).toBe('gratis')
  })

  it('exclui por capacidade abaixo do minimo', () => {
    const r = scoreAgents(base, priceOf, scoring, { intent: null, promptTokens: 100 })
    const gratis = r.ranking.find((x) => x.agent === 'gratis')
    expect(gratis?.excluded).toContain('abaixo do minimo')
    expect(r.chosen?.agent).toBe('barato')
  })

  it('exclui por limite de tokens do pedido e por janela insuficiente', () => {
    const r = scoreAgents(base, priceOf, scoring, { intent: 'explicar', promptTokens: 3000 })
    expect(r.ranking.find((x) => x.agent === 'gratis')?.excluded).toContain('acima do limite')
    const janela = scoreAgents(
      [candidate({ name: 'curto', provider: 'deepseek', model: 'flash', contextWindow: 4000, maxOutput: 3000 })],
      priceOf,
      scoring,
      { intent: null, promptTokens: 1000 },
    )
    expect(janela.chosen).toBeNull()
    expect(janela.ranking[0].excluded).toContain('janela')
  })

  it('exclui indisponivel e sem preco', () => {
    const r = scoreAgents(
      [...base, candidate({ name: 'sem-preco', provider: 'x', model: 'y' })],
      priceOf,
      scoring,
      { intent: 'implementar', promptTokens: 100, unavailable: (n) => (n === 'barato' ? 'sem chave' : null) },
    )
    expect(r.ranking.find((x) => x.agent === 'barato')?.excluded).toBe('sem chave')
    expect(r.ranking.find((x) => x.agent === 'sem-preco')?.excluded).toContain('sem preco')
    expect(r.chosen?.agent).toBe('caro')
  })

  it('empate decide pelo custo menor e depois pelo nome', () => {
    const r = scoreAgents(
      [
        candidate({ name: 'b', provider: 'ollama', model: 'qwen', capabilities: { '*': 0.7 } }),
        candidate({ name: 'a', provider: 'ollama', model: 'qwen', capabilities: { '*': 0.7 } }),
      ],
      priceOf,
      scoring,
      { intent: null, promptTokens: 100 },
    )
    expect(r.ranking.map((x) => x.agent)).toEqual(['a', 'b'])
  })

  it('respeita a lista exclude do routing.json', () => {
    const r = scoreAgents(base, priceOf, ScoringSchema.parse({ exclude: ['barato'] }), { intent: 'implementar', promptTokens: 100 })
    expect(r.ranking.find((x) => x.agent === 'barato')?.excluded).toContain('excluido')
    expect(r.chosen?.agent).toBe('caro')
  })
})
