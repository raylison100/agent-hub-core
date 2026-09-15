import { readFileSync } from 'node:fs'
import type { Usage } from '../types.js'

export interface ModelPrice {
  input: number | null
  output: number | null
  cache_read?: number | null
  cache_write?: number | null
  reasoning?: number | null
  note?: string
}

export interface TimeDiscount {
  multiplier: number
  peak_utc: {
    weekdays_only?: boolean
    ranges: [string, string][]
  }
}

export interface PricingTable {
  version: string
  models: Record<string, ModelPrice>
  time_discounts?: Record<string, TimeDiscount>
}

export class PricingMissingError extends Error {
  constructor(readonly key: string, readonly field?: string) {
    super(field ? `Preço de ${field} ausente para ${key}` : `Modelo ${key} sem preço na tabela`)
  }
}

const perMillion = 1_000_000

export class Pricing {
  constructor(private readonly table: PricingTable) {}

  static fromFile(path: string): Pricing {
    return new Pricing(JSON.parse(readFileSync(path, 'utf8')) as PricingTable)
  }

  get version(): string {
    return this.table.version
  }

  /** Idade da tabela em dias, quando `version` e uma data ISO; null quando nao da para saber. */
  ageDays(now: Date = new Date()): number | null {
    const parsed = Date.parse(this.table.version)
    if (Number.isNaN(parsed)) return null
    return Math.floor((now.getTime() - parsed) / 86_400_000)
  }

  /** Encontra o preco de um modelo, aceitando curinga `provider/*`. */
  resolve(provider: string, model: string): ModelPrice {
    const key = `${provider}/${model}`
    const exact = this.table.models[key]
    if (exact) return exact
    const wildcard = this.table.models[`${provider}/*`]
    if (wildcard) return wildcard
    throw new PricingMissingError(key)
  }

  /** Multiplicador de preco no instante dado: 1 no pico ou sem desconto declarado, o `multiplier` fora do pico. */
  multiplierAt(provider: string, model: string, at: Date = new Date()): number {
    const discount = this.table.time_discounts?.[`${provider}/${model}`] ?? this.table.time_discounts?.[`${provider}/*`]
    if (!discount) return 1
    return inPeak(discount.peak_utc, at) ? 1 : discount.multiplier
  }

  /** Preco efetivo no instante dado, com o desconto fora de pico aplicado a todos os campos. */
  effective(provider: string, model: string, at: Date = new Date()): ModelPrice {
    const price = this.resolve(provider, model)
    const m = this.multiplierAt(provider, model, at)
    if (m === 1) return price
    const scale = (v: number | null | undefined): number | null | undefined => (typeof v === 'number' ? v * m : v)
    return { ...price, input: scale(price.input) ?? null, output: scale(price.output) ?? null, cache_read: scale(price.cache_read), cache_write: scale(price.cache_write), reasoning: scale(price.reasoning) }
  }

  /** Calcula o custo em USD de um uso no instante dado, falhando se algum preco necessario for nulo. */
  cost(provider: string, model: string, usage: Usage, at: Date = new Date()): number {
    const key = `${provider}/${model}`
    const price = this.effective(provider, model, at)
    const input = required(price.input, key, 'input')
    const output = required(price.output, key, 'output')
    const cacheRead = usage.cacheRead > 0 ? required(price.cache_read ?? null, key, 'cache_read') : 0
    const cacheWrite = usage.cacheWrite > 0 ? required(price.cache_write ?? null, key, 'cache_write') : 0
    const reasoning = price.reasoning ?? output
    const total =
      usage.input * input +
      usage.output * output +
      usage.cacheRead * cacheRead +
      usage.cacheWrite * cacheWrite +
      usage.reasoning * reasoning
    return total / perMillion
  }
}

/** Um instante esta no pico quando cai em alguma janela UTC declarada, respeitando a restricao de dias uteis. */
function inPeak(peak: TimeDiscount['peak_utc'], at: Date): boolean {
  if (peak.weekdays_only) {
    const day = at.getUTCDay()
    if (day === 0 || day === 6) return false
  }
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes()
  return peak.ranges.some(([start, end]) => minute >= minutesOf(start) && minute < minutesOf(end))
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m ?? 0)
}

function required(value: number | null | undefined, key: string, field: string): number {
  if (value === null || value === undefined) throw new PricingMissingError(key, field)
  return value
}
