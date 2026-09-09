import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { Budget, BudgetExceededError } from '../src/cost/budget.js'
import { Ledger } from '../src/cost/ledger.js'

function ledgerWith(costs: number[]): Ledger {
  const ledger = new Ledger(new Database(':memory:'))
  costs.forEach((costUsd, i) =>
    ledger.record({
      ts: Date.now(),
      sessionId: 's1',
      runId: 'r1',
      step: i + 1,
      agent: 'a',
      provider: 'anthropic',
      model: 'claude-opus-5',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false },
      costUsd,
      pricingVersion: 'teste',
      latencyMs: 10,
      stopReason: 'tool',
    }),
  )
  return ledger
}

describe('Budget', () => {
  it('lanca ao exceder o run', () => {
    const budget = new Budget(ledgerWith([0.3, 0.15]), { runUsd: 0.5 }, { runId: 'r1', sessionId: 's1', agent: 'a' })
    expect(() => budget.check(0.1)).toThrow(BudgetExceededError)
  })

  it('avisa uma unica vez ao passar de 80%', () => {
    const budget = new Budget(ledgerWith([0.3]), { runUsd: 0.5 }, { runId: 'r1', sessionId: 's1', agent: 'a' })
    expect(budget.check(0.11)).toHaveLength(1)
    expect(budget.check(0.11)).toHaveLength(0)
  })

  it('override sobe o limite', () => {
    const budget = new Budget(ledgerWith([0.45]), { runUsd: 0.5 }, { runId: 'r1', sessionId: 's1', agent: 'a' })
    expect(() => budget.check(0.1)).toThrow()
    budget.override('run', 1)
    expect(() => budget.check(0.1)).not.toThrow()
  })

  it('ledger agrega por agente e devolve ultimo input', () => {
    const ledger = ledgerWith([0.1, 0.2])
    expect(ledger.totals({ agent: 'a' }).costUsd).toBeCloseTo(0.3)
    expect(ledger.report('agent')[0]?.calls).toBe(2)
    expect(ledger.lastInputTokens('s1')).toBe(100)
  })
})
