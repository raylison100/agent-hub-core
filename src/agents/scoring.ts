import { z } from 'zod'
import type { ModelPrice } from '../cost/pricing.js'

export const ScoringSchema = z.object({
  cost_weight: z.number().min(0).max(1).default(0.5),
  batch_cost_weight: z.number().min(0).max(1).default(0.85),
  context_weight: z.number().min(0).max(1).default(0.2),
  expected_output_tokens: z.number().int().positive().default(1200),
  min_capability: z.number().min(0).max(1).default(0.5),
  context_margin: z.number().min(1).default(1.5),
  exclude: z.array(z.string()).default([]),
  feedback: z
    .object({
      good: z.number().min(0).default(0.02),
      bad: z.number().min(0).default(0.05),
      limit: z.number().min(0).max(0.5).default(0.2),
    })
    .default({ good: 0.02, bad: 0.05, limit: 0.2 }),
})

export type Scoring = z.infer<typeof ScoringSchema>

export interface ScoreCandidate {
  name: string
  provider: string
  model: string
  capabilities: Record<string, number>
  maxPromptTokens?: number
  contextWindow: number
  maxOutput: number
  vision?: boolean
  delegates?: boolean
  latency?: 'interativo' | 'lote' | 'ambos'
}

export interface ScoreInput {
  intent: string | null
  promptTokens: number
  contextTokens?: number
  needsVision?: boolean
  needsDelegation?: boolean
  latency?: 'interativo' | 'lote'
  unavailable?: (name: string) => string | null
  adjustments?: Record<string, number>
}

export interface ScoredAgent {
  agent: string
  score: number
  capability: number
  adjustment: number
  costPerMillion: number
  estimatedUsd: number
  contextUse: number
  excluded?: string
}

export interface ScoreResult {
  chosen: ScoredAgent | null
  ranking: ScoredAgent[]
}

const inputShare = 0.7

/** Converte contagens de feedback bom e ruim no ajuste de capacidade, limitado para nenhum agente fugir da faixa aprendivel. */
export function feedbackDelta(good: number, bad: number, cfg: Scoring['feedback']): number {
  const raw = good * cfg.good - bad * cfg.bad
  return Math.round(Math.max(-cfg.limit, Math.min(cfg.limit, raw)) * 10000) / 10000
}

/** Custo por milhao de tokens ponderado em 70% entrada e 30% saida, o perfil tipico de um run com ferramentas. */
export function blendedCost(price: ModelPrice): number | null {
  if (price.input === null || price.output === null) return null
  return price.input * inputShare + price.output * (1 - inputShare)
}

/** Custo estimado desta chamada em USD: o contexto que vai na entrada mais a saida esperada, pelo preco do modelo. */
export function callCost(price: ModelPrice, contextTokens: number, outputTokens: number): number | null {
  if (price.input === null || price.output === null) return null
  return (contextTokens * price.input + outputTokens * price.output) / 1_000_000
}

/** Pontua cada agente por capacidade menos o custo da chamada e a pressao de janela, de forma deterministica, e devolve o vencedor com o ranking completo. */
export function scoreAgents(
  candidates: ScoreCandidate[],
  priceOf: (provider: string, model: string) => ModelPrice | null,
  scoring: Scoring,
  input: ScoreInput,
): ScoreResult {
  const rows = candidates.map((c) => evaluate(c, priceOf, scoring, input))
  const eligible = rows.filter((r) => r.excluded === undefined)
  const tokens = contextOf(input) + scoring.expected_output_tokens
  const perMillion = (r: ScoredAgent) => (r.estimatedUsd * 1_000_000) / tokens
  const maxCost = Math.max(0, ...eligible.map((r) => Math.log1p(perMillion(r))))
  for (const r of eligible) {
    const costNorm = maxCost > 0 ? Math.log1p(perMillion(r)) / maxCost : 0
    const peso = input.latency === 'lote' ? scoring.batch_cost_weight : scoring.cost_weight
    r.score = round(r.capability - peso * costNorm - scoring.context_weight * pressure(r.contextUse))
  }
  eligible.sort(byScore)
  const excluded = rows.filter((r) => r.excluded !== undefined).sort((a, b) => a.agent.localeCompare(b.agent))
  return { chosen: eligible[0] ?? null, ranking: [...eligible, ...excluded] }
}

/** Contexto que vai na chamada: historico da sessao mais o pedido, ou so o pedido quando o chamador nao sabe o historico. */
function contextOf(input: ScoreInput): number {
  return input.contextTokens ?? input.promptTokens
}

/** Janela ate a metade nao pesa; da metade em diante a penalidade cresce ate 1 na janela cheia. */
function pressure(contextUse: number): number {
  return contextUse <= 0.5 ? 0 : Math.min(1, (contextUse - 0.5) / 0.5)
}

function evaluate(
  c: ScoreCandidate,
  priceOf: (provider: string, model: string) => ModelPrice | null,
  scoring: Scoring,
  input: ScoreInput,
): ScoredAgent {
  const declared = c.capabilities[input.intent ?? '*'] ?? c.capabilities['*']
  const adjustment = input.adjustments?.[c.name] ?? 0
  const capability = declared === undefined ? undefined : Math.max(0, Math.min(1, declared + adjustment))
  const price = priceOf(c.provider, c.model)
  const cost = price ? blendedCost(price) : null
  const contexto = contextOf(input)
  const usd = price ? callCost(price, contexto, scoring.expected_output_tokens) : null
  const contextUse = round((contexto * scoring.context_margin + c.maxOutput) / c.contextWindow)
  const row: ScoredAgent = {
    agent: c.name,
    score: 0,
    capability: capability ?? 0,
    adjustment,
    costPerMillion: cost ?? 0,
    estimatedUsd: usd ?? 0,
    contextUse,
  }
  row.excluded = exclusionReason(c, capability, cost, scoring, input)
  if (row.excluded === undefined) delete row.excluded
  return row
}

function exclusionReason(
  c: ScoreCandidate,
  capability: number | undefined,
  cost: number | null,
  scoring: Scoring,
  input: ScoreInput,
): string | undefined {
  if (scoring.exclude.includes(c.name)) return 'excluído em routing.json'
  if (input.needsVision && !c.vision) return 'não lê imagens'
  if (input.needsDelegation && !c.delegates) return 'não delega subtarefas'
  if ((input.latency ?? 'interativo') === 'interativo' && c.latency === 'lote') return 'só serve para tarefa em lote'
  const unavailable = input.unavailable?.(c.name)
  if (unavailable) return unavailable
  if (capability === undefined) return `sem capacidade declarada para ${input.intent ?? 'intenção desconhecida'}`
  if (capability < scoring.min_capability) return `capacidade ${capability} abaixo do mínimo ${scoring.min_capability}`
  if (cost === null) return 'sem preço na tabela'
  const contexto = contextOf(input)
  if (c.maxPromptTokens !== undefined && contexto > c.maxPromptTokens) return `contexto de ${contexto} tokens acima do limite ${c.maxPromptTokens}`
  if (c.contextWindow < contexto * scoring.context_margin + c.maxOutput) return `janela de ${c.contextWindow} tokens insuficiente para ${contexto} de contexto`
  return undefined
}

function byScore(a: ScoredAgent, b: ScoredAgent): number {
  return b.score - a.score || a.estimatedUsd - b.estimatedUsd || a.agent.localeCompare(b.agent)
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}
