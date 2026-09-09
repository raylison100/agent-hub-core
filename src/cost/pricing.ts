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

export interface PricingTable {
  version: string
  models: Record<string, ModelPrice>
}

export class PricingMissingError extends Error {
  constructor(readonly key: string, readonly field?: string) {
    super(field ? `Preco de ${field} ausente para ${key}` : `Modelo ${key} sem preco na tabela`)
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

  /** Encontra o preco de um modelo, aceitando curinga `provider/*`. */
  resolve(provider: string, model: string): ModelPrice {
    const key = `${provider}/${model}`
    const exact = this.table.models[key]
    if (exact) return exact
    const wildcard = this.table.models[`${provider}/*`]
    if (wildcard) return wildcard
    throw new PricingMissingError(key)
  }

  /** Calcula o custo em USD de um uso, falhando se algum preco necessario for nulo. */
  cost(provider: string, model: string, usage: Usage): number {
    const key = `${provider}/${model}`
    const price = this.resolve(provider, model)
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

function required(value: number | null | undefined, key: string, field: string): number {
  if (value === null || value === undefined) throw new PricingMissingError(key, field)
  return value
}
