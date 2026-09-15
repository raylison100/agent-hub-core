import type { SessionResume } from '../agents/resume.js'
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
  group: string | null
  role: string | null
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
  role?: string
  workspace: string
  prompt: string
  mode: 'draft' | 'normal'
  budget: { run_usd: number; day_usd: number }
  overlap: 'queue' | 'skip'
  missed: 'skip' | 'run_once'
  notify?: AutomationChannel[]
  enabled: boolean
}

export type CanalId = 'telegram' | 'slack' | 'discord' | 'whatsapp'

export type AutomationChannel = string

export interface PessoaDoCanal {
  id: string
  nome?: string
  usuario?: string
  conversa?: string
}

export interface TipoDeCanalResumo {
  id: CanalId
  nome: string
  descricao: string
  disponivel: boolean
}

export interface EstadoDoCanal {
  id: string
  tipo: CanalId
  nome: string
  descricao: string
  passos: string[]
  campos: { chave: string; rotulo: string; segredo: boolean; obrigatorio: boolean; ajuda?: string; exemplo?: string; preenchido: boolean; dica: string }[]
  configurado: boolean
  conta: string | null
  link: string | null
  ligado: boolean
  rodando: boolean
  erro: string | null
  padrao: { agente?: string; papel?: string; workspace?: string }
  permitidos: PessoaDoCanal[]
  pedidos: (PessoaDoCanal & { em: number })[]
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

export interface BackgroundTask {
  task_id: string
  run_id: string
  session_id: string
  session_title: string
  agent: string
  task: string
  status: 'rodando' | 'pronto' | 'erro'
  cost_usd: number
  collected: boolean
  started_at: number
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
  | { type: 'auth.login'; password: string; device_name: string; protocol_version: number; client: string }
  | { type: 'auth.password'; password: string }
  | { type: 'auth.devices' }
  | { type: 'auth.revoke'; device_id: string }
  | { type: 'compartilhar.listar' }
  | { type: 'compartilhar.criar'; nome: string; modelos: string[]; limite_tokens_dia: number; janela: number }
  | { type: 'compartilhar.revogar'; id: string }
  | { type: 'recebidos.listar' }
  | { type: 'recebidos.adicionar'; convite: string; no_roteamento?: boolean }
  | { type: 'recebidos.remover'; id: string }
  | { type: 'recebidos.testar'; id: string }
  | { type: 'session.create'; agent?: string; role?: string; workspace: string; title?: string; text?: string }
  | { type: 'session.list'; limit?: number; include_archived?: boolean }
  | { type: 'session.get'; session_id: string }
  | { type: 'session.update'; session_id: string; title?: string; pinned?: boolean; archived?: boolean; agent?: string; role?: string | null; mode?: RunMode; group?: string | null }
  | { type: 'session.update_many'; session_ids: string[]; pinned?: boolean; archived?: boolean; group?: string | null }
  | { type: 'session.delete_many'; session_ids: string[] }
  | { type: 'session.delete'; session_id: string }
  | { type: 'session.fork'; session_id: string }
  | { type: 'session.resume'; session_id: string }
  | {
      type: 'run.start'
      session_id: string
      text: string
      mode?: RunMode
      reasoning?: 'low' | 'medium' | 'high' | 'max'
      agent?: string
      role?: string
      improve?: boolean
      images?: { media_type: string; data: string; name?: string }[]
      run_usd?: number
      budget_scope?: 'run' | 'session' | 'agent' | 'global'
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
  | { type: 'mcp.add'; text: string }
  | { type: 'mcp.remove'; name: string }
  | { type: 'mcp.toggle'; name: string; enabled: boolean }
  | { type: 'mcp.import'; source: 'claude-code' }
  | { type: 'mcp.connect'; name: string }
  | { type: 'mcp.agents'; name: string; agents: string[] }
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
  | { type: 'workflow.resume'; run_id: string }
  | { type: 'secrets.list' }
  | { type: 'secrets.set'; name: string; value: string }
  | { type: 'secrets.delete'; name: string }
  | { type: 'canais.estado' }
  | { type: 'canal.criar'; tipo: CanalId; nome: string }
  | { type: 'canal.salvar'; canal: string; valores: Record<string, string> }
  | { type: 'canal.padrao'; canal: string; nome?: string; agente?: string; papel?: string; workspace?: string }
  | { type: 'canal.ligar'; canal: string; ligado: boolean }
  | { type: 'canal.permitir'; canal: string; pessoa: string }
  | { type: 'canal.remover_pessoa'; canal: string; pessoa: string }
  | { type: 'canal.testar'; canal: string }
  | { type: 'canal.apagar'; canal: string }
  | { type: 'fs.list'; session_id?: string; workspace?: string; path?: string }
  | { type: 'fs.read'; session_id?: string; workspace?: string; path: string; max_chars?: number }
  | { type: 'fs.tree'; session_id?: string; workspace?: string; path?: string; depth?: number }
  | { type: 'skills.list'; agent?: string }
  | { type: 'skill.get'; name: string }
  | { type: 'plugins.list' }
  | { type: 'plugins.claude_code' }
  | { type: 'plugins.adicionar'; path?: string; git?: string; ref?: string }
  | { type: 'plugins.remover'; chave: string }
  | { type: 'plugins.alternar'; chave: string; enabled: boolean }
  | { type: 'plugins.papel'; plugin: string; modelos: string[] }
  | { type: 'routing.info' }
  | { type: 'workspace.roots' }
  | { type: 'workspace.list'; path: string }
  | { type: 'workspace.find'; name: string }
  | { type: 'context.list'; workspace: string }
  | { type: 'context.delete'; workspace: string; file: string }
  | { type: 'feedback.set'; session_id: string; run_id: string; verdict: 'good' | 'bad' | 'none' }
  | { type: 'feedback.list'; session_id: string }
  | { type: 'feedback.summary' }
  | { type: 'stats.overview'; days?: number }
  | { type: 'health.list' }
  | { type: 'daemon.reload' }
  | { type: 'daemon.restart' }
  | { type: 'arquivo.ler'; session_id: string; path: string }
  | { type: 'midia.ler'; ref: string }
  | { type: 'versao.consultar'; forcar?: boolean }
  | { type: 'versao.atualizar' }
  | { type: 'hooks.list' }
  | { type: 'hooks.toggle'; id: string; enabled: boolean }
  | { type: 'term.open'; session_id: string; cols: number; rows: number; term_id?: string }
  | { type: 'term.input'; term_id: string; data: string }
  | { type: 'term.resize'; term_id: string; cols: number; rows: number }
  | { type: 'term.close'; term_id: string }
  | { type: 'tasks.list'; session_id?: string }

export type ServerFrame =
  | { type: 'auth.ok'; protocol_version: number; device: string; senha_definida?: boolean }
  | { type: 'auth.credential'; credential: string; device_id: string; device: string }
  | { type: 'auth.devices'; devices: DeviceSummary[]; senha_definida: boolean }
  | { type: 'compartilhar.lista'; relay_configurado: boolean; modelos_locais: string[]; convidados: ConvidadoResumo[] }
  | { type: 'compartilhar.criado'; convite: string; convidado: ConvidadoResumo }
  | { type: 'recebidos.lista'; recebidos: RecebidoResumo[] }
  | { type: 'recebidos.teste'; id: string; ok: boolean; detalhe: string; ms: number }
  | { type: 'auth.error'; message: string }
  | { type: 'error'; message: string; ref?: string }
  | { type: 'session.created'; session: SessionSummary; routed?: { intent: string | null; rule: unknown } }
  | { type: 'budget.overridden'; run_id: string; scope: string; limit_usd: number }
  | { type: 'session.list'; sessions: SessionSummary[] }
  | { type: 'session.get'; session: SessionSummary; messages: Message[]; children: { run_id: string; parent_run_id: string; agent: string; messages: Message[] }[]; resume: SessionResumeRecord | null }
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.deleted'; session_id: string }
  | { type: 'session.resume'; session_id: string; resume: SessionResumeRecord | null }
  | { type: 'session.deleted_many'; session_ids: string[] }
  | { type: 'run.started'; run_id: string; session_id: string }
  | { type: 'routing.info'; default_agent: string | null; improver: string | null; classifier: string | null }
  | { type: 'workspace.roots'; roots: string[]; wsl_distro: string | null }
  | { type: 'workspace.list'; path: string; dirs: string[]; repo: boolean; repos: string[] }
  | { type: 'workspace.find'; name: string; paths: string[] }
  | { type: 'context.list'; workspace: string; memories: ContextFile[]; specs: ContextFile[]; decisions: ContextFile[] }
  | { type: 'feedback.ok'; session_id: string; run_id: string; verdict: 'good' | 'bad' | 'none' }
  | { type: 'feedback.list'; session_id: string; items: { run_id: string; verdict: 'good' | 'bad' }[] }
  | { type: 'feedback.summary'; rows: { agent: string; intent: string; good: number; bad: number; delta: number }[] }
  | { type: 'stats.overview'; stats: StatsOverview }
  | { type: 'health.list'; items: HealthItem[] }
  | { type: 'versao.estado'; estado: EstadoDaVersao }
  | { type: 'arquivo.conteudo'; session_id: string; path: string; media_type: string; data: string; size: number }
  | { type: 'midia.conteudo'; ref: string; media_type: string; data: string }
  | { type: 'daemon.status'; supervisionado: boolean; reiniciando: boolean; detalhe: string }
  | { type: 'hooks.list'; catalog: HookCatalogItem[]; extras: number }
  | { type: 'term.opened'; term_id: string; session_id: string; cwd: string; buffer: string }
  | { type: 'term.data'; term_id: string; data: string }
  | { type: 'term.exit'; term_id: string; code: number }
  | { type: 'tasks.list'; tasks: BackgroundTask[] }
  | { type: 'event'; session_id: string; run_id: string; seq: number; event: RunEvent }
  | { type: 'approval.required'; approval_id: string; session_id: string; run_id: string; tool: string; args: unknown; risk: string; expires_at: number }
  | { type: 'approval.resolved'; approval_id: string; decision: string }
  | { type: 'agents.list'; agents: AgentSummary[]; roles: RoleSummary[]; errors: { file: string; message: string }[] }
  | { type: 'cost.report'; rows: { key: string; costUsd: number; calls: number; input: number; output: number; cacheRead: number }[] }
  | { type: 'cost.export'; csv: string; rows: number }
  | {
      type: 'cost.status'
      today_usd: number
      month_usd: number
      global_month_limit_usd: number | null
      agents: Record<string, { today_usd: number; day_limit_usd: number | null }>
    }
  | { type: 'sync'; session_id: string; events: { seq: number; run_id: string; event: RunEvent }[]; active_run_ids?: string[] }
  | { type: 'schedule.list'; schedules: ScheduleStatus[]; paused: boolean }
  | { type: 'schedule.saved'; schedule: ScheduleStatus }
  | { type: 'schedule.deleted'; id: string }
  | { type: 'automation.state'; paused: boolean }
  | { type: 'automation.started'; kind: 'schedule' | 'trigger'; id: string; session_id: string; run_id: string }
  | {
      type: 'automation.finished'
      kind: 'schedule' | 'trigger'
      id: string
      session_id: string
      run_id: string
      stop: string
      cost_usd: number
      workspace?: string
      notify?: AutomationChannel[]
      text?: string
    }
  | { type: 'automation.error'; kind: 'schedule' | 'trigger'; id: string; message: string }
  | { type: 'automation.runs'; runs: AutomationRun[] }
  | {
      type: 'mcp.servers'
      servers: { name: string; connected: boolean; enabled: boolean; transport: 'stdio' | 'http'; command: string; args: string[]; url: string | null; tools: number; error: string | null; agents: string[]; oauth: 'autorizado' | 'pendente' | null }[]
    }
  | { type: 'mcp.authorized'; server: string }
  | { type: 'mcp.saved'; added: string[]; secrets: string[] }
  | { type: 'mcp.agents'; name: string; agents: string[] }
  | { type: 'mcp.resources'; server: string; resources: { uri: string; name?: string; description?: string; mimeType?: string }[] }
  | { type: 'mcp.resource.read'; server: string; uri: string; text: string }
  | { type: 'mcp.prompts'; server: string; prompts: { name: string; description?: string; arguments?: { name: string; required?: boolean }[] }[] }
  | { type: 'mcp.prompt.get'; server: string; name: string; text: string }
  | { type: 'workflow.list'; workflows: WorkflowSummary[]; pending: WorkflowRunState[] }
  | { type: 'workflow.started'; name: string; session_id: string; run_id: string; max_cost_usd: number | null }
  | { type: 'workflow.step'; session_id: string; run_id: string; step: string; status: 'running' | 'done' | 'error' | 'retry' | 'escalated'; ms?: number; cost_usd?: number; detail?: string }
  | { type: 'workflow.finished'; name: string; session_id: string; run_id: string; status: 'done' | 'error' | 'budget_exceeded' | 'escalated'; cost_usd: number; outputs: Record<string, unknown>; error?: string; resumable?: boolean }
  | { type: 'secrets.list'; secrets: { name: string; hint: string; length: number; updated_at: number; source: 'db' | 'env' }[] }
  | { type: 'canais.estado'; tipos: TipoDeCanalResumo[]; canais: EstadoDoCanal[]; aviso?: string; criado?: string }
  | { type: 'fs.list'; path: string; entries: { name: string; dir: boolean }[] }
  | { type: 'fs.read'; path: string; text: string; truncated: boolean }
  | { type: 'fs.tree'; path: string; text: string }
  | { type: 'skills.list'; skills: { name: string; description: string; source: string }[] }
  | { type: 'skill.get'; name: string; body: string }
  | { type: 'plugins.list'; plugins: PluginResumo[] }
  | { type: 'plugins.claude_code'; plugins: PluginDoClaudeCode[] }
  | { type: 'plugins.papel_criado'; papel: string; arquivo: string }
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

export interface RoleSummary {
  name: string
  description: string
  models: string[]
  tools: string[]
  policy: string | null
}


export interface WorkflowRunState {
  runId: string
  name: string
  sessionId: string
  workspace: string
  context: Record<string, unknown>
  nextStep?: string
  status: string
  costUsd: number
  updatedAt: number
}

export interface HookCatalogItem {
  id: string
  title: string
  detail: string
  event: string
  tool?: string
  enabled: boolean
}

export interface RequisitoDePlugin {
  campo: string
  variavel: string
  titulo: string
  descricao: string
  obrigatorio: boolean
  definida: boolean
}

export interface PluginResumo {
  chave: string
  name: string
  dir: string
  enabled: boolean
  descricao: string
  versao: string | null
  skills: number
  agents: number
  mcp: number
  hooks: number
  nomes_skills: string[]
  nomes_mcp: string[]
  requisitos: RequisitoDePlugin[]
  erros: string[]
  papel: string | null
}

export interface PluginDoClaudeCode {
  id: string
  nome: string
  versao: string
  descricao: string
  pasta: string
  ja_adicionado: boolean
}

export interface EstadoDaVersao {
  atual: string
  ultima: string | null
  publicada_em: string | null
  endereco_da_versao: string | null
  disponivel: boolean
  instalacao: 'pacote' | 'repositorio'
  nao_lancadas: { repositorio: string; commits: number }[]
  supervisionado: boolean
  pode_atualizar: boolean
  atualizando: boolean
  detalhe: string
  consultado_em: number | null
}

export interface ConvidadoResumo {
  id: string
  nome: string
  modelos: string[]
  janela: number
  limite_tokens_dia: number
  uso_hoje: number
  conectado: boolean
  criado_em: number
  revogado_em: number | null
}

export interface RecebidoResumo {
  id: string
  anfitriao: string
  modelos: { nome: string; janela: number }[]
  agentes: string[]
  limite_tokens_dia: number
  no_roteamento: boolean
  criado_em: number
}

export interface DeviceSummary {
  id: string
  name: string
  createdAt: number
  lastSeen: number | null
}
export interface HealthItem {
  level: 'ok' | 'aviso' | 'erro'
  title: string
  detail: string
  action: string
  route?: string
}

export interface ContextFile {
  name: string
  file: string
  bytes: number
  description?: string
  data?: string
  run?: string
  activate?: string
}

export interface SessionResumeRecord {
  sessionId: string
  runId: string | null
  resume: SessionResume
  text: string
  createdAt: number
}
