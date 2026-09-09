import type { RunEvent } from '../loop/runner.js'
import type { Decision, Message } from '../types.js'

export const protocolVersion = 1

export interface SessionSummary {
  id: string
  agent: string
  workspace: string
  title: string
  createdAt: number
  updatedAt: number
  costUsd: number
}

export type ClientFrame =
  | { type: 'auth'; token: string; protocol_version: number; client: string }
  | { type: 'session.create'; agent: string; workspace: string; title?: string }
  | { type: 'session.list'; limit?: number }
  | { type: 'session.get'; session_id: string }
  | { type: 'run.start'; session_id: string; text: string }
  | { type: 'run.cancel'; run_id: string }
  | { type: 'approval.respond'; approval_id: string; decision: Exclude<Decision, 'ask'>; remember?: boolean }
  | { type: 'budget.override'; run_id: string; scope: 'run' | 'session' | 'agent' | 'global'; limit_usd: number }
  | { type: 'agents.list' }
  | { type: 'cost.report'; group: 'agent' | 'model' | 'session' | 'day'; since?: number }
  | { type: 'sync'; session_id: string; since_seq: number }

export type ServerFrame =
  | { type: 'auth.ok'; protocol_version: number; device: string }
  | { type: 'auth.error'; message: string }
  | { type: 'error'; message: string; ref?: string }
  | { type: 'session.created'; session: SessionSummary }
  | { type: 'session.list'; sessions: SessionSummary[] }
  | { type: 'session.get'; session: SessionSummary; messages: Message[] }
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'run.started'; run_id: string; session_id: string }
  | { type: 'event'; session_id: string; run_id: string; seq: number; event: RunEvent }
  | { type: 'approval.required'; approval_id: string; session_id: string; run_id: string; tool: string; args: unknown; risk: string; expires_at: number }
  | { type: 'approval.resolved'; approval_id: string; decision: string }
  | { type: 'agents.list'; agents: AgentSummary[]; errors: { file: string; message: string }[] }
  | { type: 'cost.report'; rows: { key: string; costUsd: number; calls: number; input: number; output: number; cacheRead: number }[] }
  | { type: 'sync'; session_id: string; events: { seq: number; run_id: string; event: RunEvent }[] }

export interface AgentSummary {
  name: string
  description: string
  provider: string
  model: string
  reasoning: string
  tools: string[]
  budget: { run_usd?: number; session_usd?: number }
}
