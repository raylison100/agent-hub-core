import { describe, expect, it } from 'vitest'
import { routeRole } from '../src/agents/routing.js'

describe('routeRole', () => {
  const routing = {
    intents: { implementar: ['cria', 'crie'] },
    rules: [],
    roles: [{ when: { keywords: ['arte', 'campanha', 'stories'] }, role: 'marketing', improve: false }],
  }

  it('escolhe o papel pela palavra do pedido mesmo quando outra intencao casa antes', () => {
    expect(routeRole(routing, { text: 'Crie uma arte nova para meu pdv', workspace: '/w' })?.role).toBe('marketing')
    expect(routeRole(routing, { text: 'Crie uma campanha institucional', workspace: '/w' })?.improve).toBe(false)
  })

  it('nao casa com pedaco de palavra nem sem regra', () => {
    expect(routeRole(routing, { text: 'corrija a parte do login', workspace: '/w' })).toBeNull()
    expect(routeRole({ intents: {}, rules: [] }, { text: 'arte', workspace: '/w' })).toBeNull()
  })
})
import { PromptImproverSchema, classifierJsonSchema, improverAgent, needsDelegation, parseClassifierAnswer } from '../src/agents/routing.js'
import { OpenAICompatibleAdapter } from '../src/providers/openai-compatible.js'
import type { ChatRequest } from '../src/types.js'
import { ScoringSchema, blendedCost, callCost, feedbackDelta, scoreAgents, type ScoreCandidate } from '../src/agents/scoring.js'
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

describe('feedbackDelta', () => {
  const cfg = ScoringSchema.parse({}).feedback
  it('soma bons e ruins com pesos e limita a faixa', () => {
    expect(feedbackDelta(3, 0, cfg)).toBe(0.06)
    expect(feedbackDelta(0, 2, cfg)).toBe(-0.1)
    expect(feedbackDelta(50, 0, cfg)).toBe(0.2)
    expect(feedbackDelta(0, 50, cfg)).toBe(-0.2)
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
    expect(gratis?.excluded).toContain('abaixo do mínimo')
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
    expect(r.ranking.find((x) => x.agent === 'sem-preco')?.excluded).toContain('sem preço')
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

  it('ajuste aprendido muda o vencedor e fica limitado a 0..1', () => {
    const r = scoreAgents(base, priceOf, scoring, {
      intent: 'implementar',
      promptTokens: 100,
      adjustments: { barato: -0.2, caro: 0.1 },
    })
    expect(r.ranking.find((x) => x.agent === 'barato')?.capability).toBeCloseTo(0.6)
    expect(r.ranking.find((x) => x.agent === 'caro')?.capability).toBeCloseTo(0.95)
    expect(r.chosen?.agent).toBe('barato')
    const capped = scoreAgents(base, priceOf, scoring, { intent: 'implementar', promptTokens: 100, adjustments: { caro: 0.5 } })
    expect(capped.ranking.find((x) => x.agent === 'caro')?.capability).toBe(1)
  })

  it('respeita a lista exclude do routing.json', () => {
    const r = scoreAgents(base, priceOf, ScoringSchema.parse({ exclude: ['barato'] }), { intent: 'implementar', promptTokens: 100 })
    expect(r.ranking.find((x) => x.agent === 'barato')?.excluded).toContain('excluído')
    expect(r.chosen?.agent).toBe('caro')
  })

  it('pedido de subagente exclui quem nao delega', () => {
    const comDelegacao = [
      candidate({ name: 'caro', provider: 'anthropic', model: 'opus', capabilities: { '*': 0.85 }, delegates: true }),
      candidate({ name: 'barato', provider: 'deepseek', model: 'flash', capabilities: { '*': 0.7 } }),
    ]
    const semPedido = scoreAgents(comDelegacao, priceOf, scoring, { intent: null, promptTokens: 100 })
    expect(semPedido.chosen?.agent).toBe('barato')
    const r = scoreAgents(comDelegacao, priceOf, scoring, { intent: null, promptTokens: 100, needsDelegation: true })
    expect(r.ranking.find((x) => x.agent === 'barato')?.excluded).toBe('não delega subtarefas')
    expect(r.chosen?.agent).toBe('caro')
  })
})

describe('needsDelegation', () => {
  it('reconhece pedido de subagente, delegacao e agentes em paralelo', () => {
    expect(needsDelegation('faz um teste de subagentes para eu ver como vc trabalha')).toBe(true)
    expect(needsDelegation('delegue a leitura dos arquivos e junte as respostas')).toBe(true)
    expect(needsDelegation('roda dois agentes em paralelo nessa tarefa')).toBe(true)
    expect(needsDelegation('usa worktree para nao mexer nos meus arquivos')).toBe(true)
  })

  it('nao confunde com pedido de codigo que fala de paralelismo', () => {
    expect(needsDelegation('implementa o processamento em paralelo com worker threads')).toBe(false)
    expect(needsDelegation('corrige o teste que quebrou no CI')).toBe(false)
  })
})

describe('pontuacao por contexto real', () => {
  const grandes: Record<string, ModelPrice> = {
    'x/saida-cara': { input: 1, output: 20 },
    'x/entrada-cara': { input: 4, output: 2 },
  }
  const precoGrande = (provider: string, model: string) => grandes[`${provider}/${model}`] ?? null
  const trio = [
    candidate({ name: 'caro', provider: 'anthropic', model: 'opus', capabilities: { '*': 0.85, implementar: 0.85 } }),
    candidate({ name: 'barato', provider: 'deepseek', model: 'flash', capabilities: { '*': 0.7, implementar: 0.8 } }),
    candidate({ name: 'gratis', provider: 'ollama', model: 'qwen', capabilities: { '*': 0.35, explicar: 0.65 }, contextWindow: 8192, maxOutput: 4000 }),
  ]

  const dois = [
    candidate({ name: 'saida-cara', provider: 'x', model: 'saida-cara', capabilities: { '*': 0.7 }, contextWindow: 1000000 }),
    candidate({ name: 'entrada-cara', provider: 'x', model: 'entrada-cara', capabilities: { '*': 0.7 }, contextWindow: 1000000 }),
  ]

  it('pedido curto favorece quem cobra pouco na saida; contexto grande favorece quem cobra pouco na entrada', () => {
    const curto = scoreAgents(dois, precoGrande, scoring, { intent: null, promptTokens: 200, contextTokens: 200 })
    expect(curto.chosen?.agent).toBe('entrada-cara')
    const longo = scoreAgents(dois, precoGrande, scoring, { intent: null, promptTokens: 200, contextTokens: 500000 })
    expect(longo.chosen?.agent).toBe('saida-cara')
    expect(longo.ranking[0]?.estimatedUsd).toBeCloseTo(0.524, 3)
  })

  it('penaliza quem vai encostar na janela e nao penaliza quem tem folga', () => {
    const apertado = candidate({ name: 'apertado', provider: 'ollama', model: 'qwen', capabilities: { '*': 0.7 }, contextWindow: 20000, maxOutput: 4000 })
    const folgado = candidate({ name: 'folgado', provider: 'ollama', model: 'qwen', capabilities: { '*': 0.7 }, contextWindow: 200000, maxOutput: 4000 })
    const r = scoreAgents([apertado, folgado], priceOf, scoring, { intent: null, promptTokens: 100, contextTokens: 6000 })
    expect(r.chosen?.agent).toBe('folgado')
    expect(r.ranking.find((x) => x.agent === 'apertado')?.contextUse).toBeCloseTo(0.65, 2)
    expect(r.ranking.find((x) => x.agent === 'folgado')?.score).toBeCloseTo(0.7, 4)
    expect(r.ranking.find((x) => x.agent === 'apertado')?.score).toBeCloseTo(0.64, 4)
  })

  it('a exclusao por janela olha o contexto inteiro, nao so o pedido', () => {
    const r = scoreAgents(trio, priceOf, scoring, { intent: "explicar", promptTokens: 100, contextTokens: 100000 })
    expect(r.ranking.find((x) => x.agent === 'gratis')?.excluded).toContain('janela de 8192')
  })

  it('sem contexto informado, cai no tamanho do pedido', () => {
    const r = scoreAgents(trio, priceOf, scoring, { intent: 'implementar', promptTokens: 100 })
    expect(r.chosen?.agent).toBe('barato')
  })
})

describe('callCost', () => {
  it('soma entrada e saida pelo preco do modelo', () => {
    expect(callCost({ input: 2, output: 12 }, 10000, 1000)).toBeCloseTo(0.032, 6)
  })
  it('devolve null quando falta preco', () => {
    expect(callCost({ input: 2, output: null }, 100, 100)).toBeNull()
  })
})

describe('improverAgent', () => {
  const cfg = PromptImproverSchema.parse({ agent: 'qwen3', remote_agent: 'gemini', max_local_chars: 50 })

  it('pedido curto fica no modelo local', () => {
    expect(improverAgent(cfg, 'cria uma funcao que soma dois numeros')).toBe('qwen3')
  })

  it('pedido grande vai para o remoto', () => {
    expect(improverAgent(cfg, 'x'.repeat(200))).toBe('gemini')
  })

  it('sem remoto declarado, sempre o local', () => {
    expect(improverAgent(PromptImproverSchema.parse({ agent: 'qwen3' }), 'x'.repeat(5000))).toBe('qwen3')
  })
})

describe('classe de latencia', () => {
  const dupla = [
    candidate({ name: 'rapido', provider: 'deepseek', model: 'flash', capabilities: { '*': 0.7 } }),
    candidate({ name: 'lento', provider: 'ollama', model: 'qwen', capabilities: { '*': 0.6 }, latency: 'lote' }),
  ]

  it('pedido interativo exclui quem so serve para lote', () => {
    const r = scoreAgents(dupla, priceOf, scoring, { intent: null, promptTokens: 100 })
    expect(r.ranking.find((x) => x.agent === 'lento')?.excluded).toBe('só serve para tarefa em lote')
    expect(r.chosen?.agent).toBe('rapido')
  })

  it('em lote o gratuito entra e o custo pesa mais', () => {
    const r = scoreAgents(dupla, priceOf, scoring, { intent: null, promptTokens: 100, latency: 'lote' })
    expect(r.chosen?.agent).toBe('lento')
    const interativo = scoreAgents([dupla[0]!], priceOf, scoring, { intent: null, promptTokens: 100 })
    const lote = scoreAgents([dupla[0]!], priceOf, scoring, { intent: null, promptTokens: 100, latency: 'lote' })
    expect(lote.chosen!.score).toBeLessThan(interativo.chosen!.score)
  })
})

describe('classificador com saida estruturada', () => {
  const intents = { revisar: ['revise'], implementar: ['cria'] }

  it('declara as intencoes e a opcao nenhuma no schema', () => {
    const schema = classifierJsonSchema(intents) as { properties: { intencao: { enum: string[] } } }
    expect(schema.properties.intencao.enum).toEqual(['revisar', 'implementar', 'nenhuma'])
  })

  it('le a resposta em JSON e ainda aceita palavra solta de provedor sem gramatica', () => {
    expect(parseClassifierAnswer('{"intencao":"revisar"}', intents)).toBe('revisar')
    expect(parseClassifierAnswer('{"intencao":"nenhuma"}', intents)).toBeNull()
    expect(parseClassifierAnswer('{"intencao":"inventada"}', intents)).toBeNull()
    expect(parseClassifierAnswer('implementar', intents)).toBe('implementar')
  })
})

describe('formato de resposta nos adaptadores compativeis com OpenAI', () => {
  const req: ChatRequest = {
    system: 's',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'oi' }] }],
    tools: [],
    maxOutput: 40,
    reasoning: 'low',
    systemCacheTtl: '5m',
    providerOptions: {},
    responseFormat: { name: 'intencao', schema: { type: 'object' } },
  }

  it('manda json_schema para o Ollama', () => {
    const ollama = new OpenAICompatibleAdapter({ provider: 'ollama', model: 'qwen3:8b', apiKey: 'x', baseURL: 'http://127.0.0.1:1/v1' })
    expect(ollama['buildParams'](req).response_format).toEqual({ type: 'json_schema', json_schema: { name: 'intencao', schema: { type: 'object' } } })
  })

  it('nao manda formato para provedor remoto, que segue so pelo prompt', () => {
    const gemini = new OpenAICompatibleAdapter({ provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'x', baseURL: 'http://127.0.0.1:1/v1' })
    const deepseek = new OpenAICompatibleAdapter({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'x', baseURL: 'http://127.0.0.1:1/v1' })
    expect(gemini['buildParams'](req).response_format).toBeUndefined()
    expect(deepseek['buildParams'](req).response_format).toBeUndefined()
  })
})
