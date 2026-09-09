import type { Ledger } from './ledger.js'

export type BudgetScope = 'run' | 'session' | 'agent' | 'global'

export interface BudgetLimits {
  runUsd?: number
  sessionUsd?: number
  agentDayUsd?: number
  globalMonthUsd?: number
}

export interface BudgetIds {
  runId: string
  sessionId: string
  agent: string
}

export interface BudgetWarning {
  scope: BudgetScope
  spentUsd: number
  limitUsd: number
}

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: BudgetScope,
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`Orcamento de ${scope} excedido: ${spentUsd.toFixed(4)} de ${limitUsd.toFixed(4)} USD`)
  }
}

const warnAt = 0.8

export class Budget {
  private readonly overrides = new Map<BudgetScope, number>()
  private readonly warned = new Set<BudgetScope>()

  constructor(
    private readonly ledger: Ledger,
    private readonly limits: BudgetLimits,
    private readonly ids: BudgetIds,
    private readonly now: () => number = Date.now,
  ) {}

  override(scope: BudgetScope, limitUsd: number): void {
    this.overrides.set(scope, limitUsd)
    this.warned.delete(scope)
  }

  /** Verifica todos os escopos com o custo estimado da proxima chamada. Lanca ao exceder, devolve avisos ao passar de 80%. */
  check(estimatedUsd: number): BudgetWarning[] {
    const warnings: BudgetWarning[] = []
    for (const scope of ['run', 'session', 'agent', 'global'] as const) {
      const limit = this.limitFor(scope)
      if (limit === undefined) continue
      const spent = this.spentFor(scope)
      if (spent + estimatedUsd > limit) throw new BudgetExceededError(scope, spent + estimatedUsd, limit)
      if (spent + estimatedUsd > limit * warnAt && !this.warned.has(scope)) {
        this.warned.add(scope)
        warnings.push({ scope, spentUsd: spent + estimatedUsd, limitUsd: limit })
      }
    }
    return warnings
  }

  spentFor(scope: BudgetScope): number {
    switch (scope) {
      case 'run':
        return this.ledger.totals({ runId: this.ids.runId }).costUsd
      case 'session':
        return this.ledger.totals({ sessionId: this.ids.sessionId }).costUsd
      case 'agent':
        return this.ledger.totals({ agent: this.ids.agent, since: startOfDay(this.now()) }).costUsd
      case 'global':
        return this.ledger.totals({ since: startOfMonth(this.now()) }).costUsd
    }
  }

  limitFor(scope: BudgetScope): number | undefined {
    const override = this.overrides.get(scope)
    if (override !== undefined) return override
    switch (scope) {
      case 'run':
        return this.limits.runUsd
      case 'session':
        return this.limits.sessionUsd
      case 'agent':
        return this.limits.agentDayUsd
      case 'global':
        return this.limits.globalMonthUsd
    }
  }
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfMonth(ts: number): number {
  const d = new Date(ts)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
