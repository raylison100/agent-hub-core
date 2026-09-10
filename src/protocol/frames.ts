import type { WorkflowSummary } from '../agents/workflows.js'
import type { RunEvent } from '../loop/runner.js'
import type { Decision, Message } from '../types.js'

export const protocolVersion = 1

/** Modos de um run: `normal` segue a politica do perfil; `accept_edits` libera escrita e pergunta execucao; `draft` so le; `auto_approve` libera tudo exceto padroes destrutivos. */
export type RunMode = 'normal' | 'accept_edits' | 'draft' | 'auto_approve'

export interface SessionSummary {
  id: string
  agent: string
  workspace: string
  title: string
  origin: string
  pinned: boolean
  archived: boolean
  mode: RunMode
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

export interface StatsOverview {
  user: string
  sessions: number
  messages: number
  total_tokens: number
  active_days: number
  current_streak_days: number
  longest_streak_days: number
  peak_hour: number | null
  favorite_model: string | null
  cost_usd: number
  days: { date: string; count: number }[]
  models: { model: string; calls: number; tokens: number; cost_usd: number }[]
}

export type ClientFrame =
  | { type: 'auth'; token: string; protocol_version: number; client: string }
  | { type: 'session.create'; agent?: string; workspace: string; title?: string; text?: string }
  | { type: 'session.list'; limit?: number; include_archived?: boolean }
  | { type: 'session.get'; session_id: string }
  | { type: 'session.update'; session_id: string; title?: string; pinned?: boolean; archived?: boolean; agent?: string; mode?: RunMode }
  | { type: 'session.delete'; session_id: string }
  | { type: 'session.fork'; session_id: string }
  | {
      type: 'run.start'
      session_id: string
      text: string
      mode?: RunMode
      reasoning?: 'low' | 'medium' | 'high' | 'max'
      agent?: string
      improve?: boolean
      images?: { media_type: string; data: string; name?: string }[]
    }
  | { type: 'cost.export'; since?: number; until?: number }
  | { type: 'cost.status' }
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
  | { type: 'workflow.list' }
  | { type: 'workflow.run'; name: string; inputs: Record<string, string>; workspace: string }
  | { type: 'secrets.list' }
  | { type: 'secrets.set'; name: string; value: string }
  | { type: 'secrets.delete'; name: string }
  | { type: 'fs.list'; session_id?: string; workspace?: string; path?: string }
  | { type: 'fs.read'; session_id?: string; workspace?: string; path: string; max_chars?: number }
  | { type: 'fs.tree'; session_id?: string; workspace?: string; path?: string; depth?: number }
  | { type: 'skills.list'; agent?: string }
  | { type: 'skill.get'; name: string }
  | { type: 'plugins.list' }
  | { type: 'routing.info' }
  | { type: 'workspace.roots' }
  | { type: 'workspace.list'; path: string }
  | { type: 'feedback.set'; session_id: string; run_id: string; verdict: 'good' | 'bad' | 'none' }
  | { type: 'feedback.list'; session_id: string }
  | { type: 'feedback.summary' }
  | { type: 'stats.overview'; days?: number }

export type ServerFrame =
  | { type: 'auth.ok'; protocol_version: number; device: string }
  | { type: 'auth.error'; message: string }
  | { type: 'error'; message: string; ref?: string }
  | { type: 'session.created'; session: SessionSummary; routed?: { intent: string | null; rule: unknown } }
  | { type: 'budget.overridden'; run_id: string; scope: string; limit_usd: number }
  | { type: 'session.list'; sessions: SessionSummary[] }
  | { type: 'session.get'; session: SessionSummary; messages: Message[]; children: { run_id: string; parent_run_id: string; agent: string; messages: Message[] }[] }
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.deleted'; session_id: string }
  | { type: 'run.started'; run_id: string; session_id: string }
  | { type: 'routing.info'; default_agent: string | null; improver: string | null; classifier: string | null }
  | { type: 'workspace.roots'; roots: string[]; wsl_distro: string | null }
  | { type: 'workspace.list'; path: string; dirs: string[] }
  | { type: 'feedback.ok'; session_id: string; run_id: string; verdict: 'good' | 'bad' | 'none' }
  | { type: 'feedback.list'; session_id: string; items: { run_id: string; verdict: 'good' | 'bad' }[] }
  | { type: 'feedback.summary'; rows: { agent: string; intent: string; good: number; bad: number; delta: number }[] }
  | { type: 'stats.overview'; stats: StatsOverview }
  | { type: 'event'; session_id: string; run_id: string; seq: number; event: RunEvent }
  | { type: 'approval.required'; approval_id: string; session_id: string; run_id: string; tool: string; args: unknown; risk: string; expires_at: number }
  | { type: 'approval.resolved'; approval_id: string; decision: string }
  | { type: 'agents.list'; agents: AgentSummary[]; errors: { file: string; message: string }[] }
  | { type: 'cost.report'; rows: { key: string; costUsd: number; calls: number; input: number; output: number; cacheRead: number }[] }
  | { type: 'cost.export'; csv: string; rows: number }
  | {
      type: 'cost.status'
      today_usd: number
      month_usd: number
      global_month_limit_usd: number | null
      agents: Record<string, { today_usd: number; day_limit_usd: number | null }>
    }
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
  | { type: 'workflow.list'; workflows: WorkflowSummary[] }
  | { type: 'workflow.started'; name: string; session_id: string; run_id: string; max_cost_usd: number | null }
  | { type: 'workflow.step'; session_id: string; run_id: string; step: string; status: 'running' | 'done' | 'error' | 'retry'; ms?: number; cost_usd?: number; detail?: string }
  | { type: 'workflow.finished'; name: string; session_id: string; run_id: string; status: 'done' | 'error' | 'budget_exceeded'; cost_usd: number; outputs: Record<string, unknown>; error?: string }
  | { type: 'secrets.list'; secrets: { name: string; hint: string; length: number; updated_at: number; source: 'db' | 'env' }[] }
  | { type: 'fs.list'; path: string; entries: { name: string; dir: boolean }[] }
  | { type: 'fs.read'; path: string; text: string; truncated: boolean }
  | { type: 'fs.tree'; path: string; text: string }
  | { type: 'skills.list'; skills: { name: string; description: string; source: string }[] }
  | { type: 'skill.get'; name: string; body: string }
  | { type: 'plugins.list'; plugins: { name: string; dir: string; skills: number; agents: number; mcp: number; hooks: number }[] }
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
  budget: { run_usd?: number; session_usd?: number; day_usd?: number }
  context_window: number
  delegates: string[]
}
