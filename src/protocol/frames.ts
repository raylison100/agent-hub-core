import type { RunEvent } from '../loop/runner.js'
import type { Decision, Message } from '../types.js'

export const protocolVersion = 1

export interface SessionSummary {
  id: string
  agent: string
  workspace: string
  title: string
  origin: string
  createdAt: number
  updatedAt: number
  costUsd: number
}

export interface ScheduleSpec {
  id: string
  cron?: string
  at?: number
  timezone: string
  agent: string
  workspace: string
  prompt: string
  mode: 'draft' | 'normal'
  budget: { run_usd: number; day_usd: number }
  overlap: 'queue' | 'skip'
  missed: 'skip' | 'run_once'
  enabled: boolean
}

export interface ScheduleStatus extends ScheduleSpec {
  source: 'file' | 'db'
  lastRunAt: number | null
  nextRunAt: number | null
  running: boolean
  todayUsd: number
}

export interface TriggerSpec {
  id: string
  source: 'gitlab' | 'github' | 'generic'
  secret_ref: string
  filter: Record<string, string | number | boolean>
  agent: string
  workspace: string
  prompt: string
  mode: 'draft' | 'normal'
  budget: { run_usd: number; day_usd: number }
  dedupe?: string
  overlap: 'queue' | 'skip'
  enabled: boolean
}

export interface TriggerStatus extends TriggerSpec {
  sourceKind: 'file' | 'db'
  lastFiredAt: number | null
  running: boolean
  todayUsd: number
}

export interface AutomationRun {
  id: string
  kind: 'schedule' | 'trigger'
  automationId: string
  sessionId: string
  runId: string
  startedAt: number
  finishedAt: number | null
  status: string
  costUsd: number
}

export type ClientFrame =
  | { type: 'auth'; token: string; protocol_version: number; client: string }
  | { type: 'session.create'; agent?: string; workspace: string; title?: string; text?: string }
  | { type: 'session.list'; limit?: number }
  | { type: 'session.get'; session_id: string }
  | { type: 'run.start'; session_id: string; text: string; mode?: 'normal' | 'draft' | 'auto_approve' }
  | { type: 'cost.export'; since?: number; until?: number }
  | { type: 'run.cancel'; run_id: string }
  | { type: 'approval.respond'; approval_id: string; decision: Exclude<Decision, 'ask'>; remember?: boolean }
  | { type: 'budget.override'; run_id: string; scope: 'run' | 'session' | 'agent' | 'global'; limit_usd: number }
  | { type: 'agents.list' }
  | { type: 'cost.report'; group: 'agent' | 'model' | 'session' | 'day'; since?: number }
  | { type: 'sync'; session_id: string; since_seq: number }
  | { type: 'schedule.list' }
  | { type: 'schedule.upsert'; schedule: ScheduleSpec }
  | { type: 'schedule.delete'; id: string }
  | { type: 'schedule.run_now'; id: string }
  | { type: 'automation.pause' }
  | { type: 'automation.resume' }
  | { type: 'automation.runs'; automation_id?: string; limit?: number }
  | { type: 'trigger.list' }
  | { type: 'trigger.upsert'; trigger: TriggerSpec }
  | { type: 'trigger.delete'; id: string }
  | { type: 'mcp.servers' }
  | { type: 'mcp.resources'; server: string }
  | { type: 'mcp.resource.read'; server: string; uri: string }
  | { type: 'mcp.prompts'; server: string }
  | { type: 'mcp.prompt.get'; server: string; name: string; args?: Record<string, string> }
  | { type: 'push.vapid' }
  | { type: 'push.subscribe'; subscription: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null } }
  | { type: 'push.unsubscribe'; endpoint: string }
  | { type: 'push.test' }

export type ServerFrame =
  | { type: 'auth.ok'; protocol_version: number; device: string }
  | { type: 'auth.error'; message: string }
  | { type: 'error'; message: string; ref?: string }
  | { type: 'session.created'; session: SessionSummary; routed?: { intent: string | null; rule: unknown } }
  | { type: 'budget.overridden'; run_id: string; scope: string; limit_usd: number }
  | { type: 'session.list'; sessions: SessionSummary[] }
  | { type: 'session.get'; session: SessionSummary; messages: Message[] }
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'run.started'; run_id: string; session_id: string }
  | { type: 'event'; session_id: string; run_id: string; seq: number; event: RunEvent }
  | { type: 'approval.required'; approval_id: string; session_id: string; run_id: string; tool: string; args: unknown; risk: string; expires_at: number }
  | { type: 'approval.resolved'; approval_id: string; decision: string }
  | { type: 'agents.list'; agents: AgentSummary[]; errors: { file: string; message: string }[] }
  | { type: 'cost.report'; rows: { key: string; costUsd: number; calls: number; input: number; output: number; cacheRead: number }[] }
  | { type: 'cost.export'; csv: string; rows: number }
  | { type: 'sync'; session_id: string; events: { seq: number; run_id: string; event: RunEvent }[] }
  | { type: 'schedule.list'; schedules: ScheduleStatus[]; paused: boolean }
  | { type: 'schedule.saved'; schedule: ScheduleStatus }
  | { type: 'schedule.deleted'; id: string }
  | { type: 'automation.state'; paused: boolean }
  | { type: 'automation.started'; kind: 'schedule' | 'trigger'; id: string; session_id: string; run_id: string }
  | { type: 'automation.finished'; kind: 'schedule' | 'trigger'; id: string; session_id: string; run_id: string; stop: string; cost_usd: number }
  | { type: 'automation.error'; kind: 'schedule' | 'trigger'; id: string; message: string }
  | { type: 'automation.runs'; runs: AutomationRun[] }
  | { type: 'mcp.servers'; servers: { name: string; connected: boolean; transport: 'stdio' | 'http' }[] }
  | { type: 'mcp.resources'; server: string; resources: { uri: string; name?: string; description?: string; mimeType?: string }[] }
  | { type: 'mcp.resource.read'; server: string; uri: string; text: string }
  | { type: 'mcp.prompts'; server: string; prompts: { name: string; description?: string; arguments?: { name: string; required?: boolean }[] }[] }
  | { type: 'mcp.prompt.get'; server: string; name: string; text: string }
  | { type: 'push.vapid'; public_key: string; subscriptions: number }
  | { type: 'push.subscribed'; endpoint: string }
  | { type: 'trigger.list'; triggers: TriggerStatus[] }
  | { type: 'trigger.saved'; trigger: TriggerStatus }
  | { type: 'trigger.deleted'; id: string }

export interface AgentSummary {
  name: string
  description: string
  provider: string
  model: string
  reasoning: string
  tools: string[]
  budget: { run_usd?: number; session_usd?: number }
}
