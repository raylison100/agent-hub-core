import type { Database } from 'better-sqlite3'
import type { Usage } from '../types.js'

export interface LedgerEntry {
  ts: number
  sessionId: string
  runId: string
  step: number
  agent: string
  provider: string
  model: string
  usage: Usage
  costUsd: number
  pricingVersion: string
  latencyMs: number
  stopReason: string
  parentRunId?: string
}

export interface LedgerFilter {
  sessionId?: string
  runId?: string
  agent?: string
  since?: number
  until?: number
}

export interface LedgerTotals {
  costUsd: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  calls: number
}

export type ReportGroup = 'agent' | 'model' | 'session' | 'day'

export interface ReportRow extends LedgerTotals {
  key: string
}

interface TotalsRow {
  cost_usd: number | null
  input: number | null
  output: number | null
  cache_read: number | null
  cache_write: number | null
  reasoning: number | null
  calls: number
}

const groupExpr: Record<ReportGroup, string> = {
  agent: 'agent',
  model: "provider || '/' || model",
  session: 'session_id',
  day: "date(ts / 1000, 'unixepoch', 'localtime')",
}

export class Ledger {
  constructor(private readonly db: Database) {
    Ledger.migrate(db)
  }

  static migrate(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        parent_run_id TEXT,
        step INTEGER NOT NULL,
        agent TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        usage_missing INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL,
        pricing_version TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        stop_reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_session ON ledger(session_id);
      CREATE INDEX IF NOT EXISTS ledger_run ON ledger(run_id);
      CREATE INDEX IF NOT EXISTS ledger_agent_ts ON ledger(agent, ts);
      CREATE INDEX IF NOT EXISTS ledger_ts ON ledger(ts);
    `)
  }

  record(e: LedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO ledger (ts, session_id, run_id, parent_run_id, step, agent, provider, model,
          input, output, cache_read, cache_write, reasoning, usage_missing, cost_usd, pricing_version, latency_ms, stop_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.ts,
        e.sessionId,
        e.runId,
        e.parentRunId ?? null,
        e.step,
        e.agent,
        e.provider,
        e.model,
        e.usage.input,
        e.usage.output,
        e.usage.cacheRead,
        e.usage.cacheWrite,
        e.usage.reasoning,
        e.usage.missing ? 1 : 0,
        e.costUsd,
        e.pricingVersion,
        e.latencyMs,
        e.stopReason,
      )
  }

  totals(filter: LedgerFilter = {}): LedgerTotals {
    const { where, params } = buildWhere(filter)
    const row = this.db
      .prepare(
        `SELECT SUM(cost_usd) AS cost_usd, SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(reasoning) AS reasoning,
                COUNT(*) AS calls
         FROM ledger ${where}`,
      )
      .get(...params) as TotalsRow
    return toTotals(row)
  }

  report(group: ReportGroup, filter: LedgerFilter = {}): ReportRow[] {
    const { where, params } = buildWhere(filter)
    const expr = groupExpr[group]
    const rows = this.db
      .prepare(
        `SELECT ${expr} AS key, SUM(cost_usd) AS cost_usd, SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(reasoning) AS reasoning,
                COUNT(*) AS calls
         FROM ledger ${where} GROUP BY key ORDER BY cost_usd DESC`,
      )
      .all(...params) as (TotalsRow & { key: string })[]
    return rows.map((r) => ({ key: r.key, ...toTotals(r) }))
  }

  lastInputTokens(sessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT input + cache_read + cache_write AS total FROM ledger
         WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { total: number } | undefined
    return row ? row.total : null
  }
}

function buildWhere(filter: LedgerFilter): { where: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (filter.sessionId) {
    clauses.push('session_id = ?')
    params.push(filter.sessionId)
  }
  if (filter.runId) {
    clauses.push('run_id = ?')
    params.push(filter.runId)
  }
  if (filter.agent) {
    clauses.push('agent = ?')
    params.push(filter.agent)
  }
  if (filter.since !== undefined) {
    clauses.push('ts >= ?')
    params.push(filter.since)
  }
  if (filter.until !== undefined) {
    clauses.push('ts < ?')
    params.push(filter.until)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

function toTotals(row: TotalsRow): LedgerTotals {
  return {
    costUsd: row.cost_usd ?? 0,
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheRead: row.cache_read ?? 0,
    cacheWrite: row.cache_write ?? 0,
    reasoning: row.reasoning ?? 0,
    calls: row.calls,
  }
}
