import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'

export const HookEventSchema = z.enum(['run.start', 'tool.before', 'tool.after', 'run.end', 'budget.exceeded'])

export const HookConfigSchema = z.object({
  event: HookEventSchema,
  command: z.string().min(1),
  match: z.object({ tool: z.string().optional(), agent: z.string().optional() }).default({}),
  timeout_ms: z.number().int().positive().default(10_000),
  format: z.enum(['agent-hub', 'claude-code']).default('agent-hub'),
  cwd: z.string().optional(),
})

export const HooksFileSchema = z.object({ hooks: z.array(HookConfigSchema).default([]) })

export type HookEvent = z.infer<typeof HookEventSchema>
export type HookConfig = z.infer<typeof HookConfigSchema>

export interface HookContext {
  sessionId: string
  runId: string
  agent: string
  workspace: string
}

export interface HookDecision {
  allow: boolean
  reason?: string
  output?: string
}

interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

const claudeToolNames: Record<string, string> = {
  run_command: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  search: 'Grep',
  list_dir: 'Glob',
}

const claudeEventNames: Record<HookEvent, string> = {
  'run.start': 'UserPromptSubmit',
  'tool.before': 'PreToolUse',
  'tool.after': 'PostToolUse',
  'run.end': 'Stop',
  'budget.exceeded': 'Notification',
}

/** Executa hooks de ciclo de vida como comandos externos, no formato proprio ou no do Claude Code. */
export class HookRunner {
  constructor(
    private readonly hooks: HookConfig[],
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  get size(): number {
    return this.hooks.length
  }

  async runStart(ctx: HookContext, text: string): Promise<HookDecision> {
    return this.decide('run.start', ctx, undefined, { prompt: text })
  }

  async before(ctx: HookContext, tool: string, args: unknown): Promise<HookDecision> {
    return this.decide('tool.before', ctx, tool, { tool, args })
  }

  /** Hooks de `tool.after` podem substituir o resultado devolvendo `output`. */
  async after(ctx: HookContext, tool: string, args: unknown, result: string): Promise<string> {
    let current = result
    for (const hook of this.select('tool.after', tool, ctx.agent)) {
      const res = await this.exec(hook, ctx, this.payload(hook, 'tool.after', ctx, { tool, args, result: current }))
      const parsed = interpret(hook, res)
      if (parsed.output !== undefined) current = parsed.output
    }
    return current
  }

  async runEnd(ctx: HookContext, summary: Record<string, unknown>): Promise<void> {
    for (const hook of this.select('run.end', undefined, ctx.agent)) {
      await this.exec(hook, ctx, this.payload(hook, 'run.end', ctx, summary)).catch((err: unknown) => this.log(describe(err)))
    }
  }

  async budgetExceeded(ctx: HookContext, summary: Record<string, unknown>): Promise<void> {
    for (const hook of this.select('budget.exceeded', undefined, ctx.agent)) {
      await this.exec(hook, ctx, this.payload(hook, 'budget.exceeded', ctx, summary)).catch((err: unknown) => this.log(describe(err)))
    }
  }

  private async decide(event: HookEvent, ctx: HookContext, tool: string | undefined, extra: Record<string, unknown>): Promise<HookDecision> {
    for (const hook of this.select(event, tool, ctx.agent)) {
      let res: ExecResult
      try {
        res = await this.exec(hook, ctx, this.payload(hook, event, ctx, extra))
      } catch (err) {
        return { allow: false, reason: `hook falhou: ${describe(err)}` }
      }
      const decision = interpret(hook, res)
      if (!decision.allow) return decision
    }
    return { allow: true }
  }

  private select(event: HookEvent, tool: string | undefined, agent: string): HookConfig[] {
    return this.hooks.filter((h) => {
      if (h.event !== event) return false
      if (h.match.agent && !new RegExp(h.match.agent).test(agent)) return false
      if (h.match.tool && tool !== undefined) {
        const candidate = h.format === 'claude-code' ? (claudeToolNames[tool] ?? tool) : tool
        if (!new RegExp(h.match.tool).test(candidate)) return false
      }
      return true
    })
  }

  private payload(hook: HookConfig, event: HookEvent, ctx: HookContext, extra: Record<string, unknown>): Record<string, unknown> {
    if (hook.format === 'claude-code') {
      const tool = typeof extra.tool === 'string' ? extra.tool : undefined
      return {
        session_id: ctx.sessionId,
        cwd: ctx.workspace,
        hook_event_name: claudeEventNames[event],
        ...(tool ? { tool_name: claudeToolNames[tool] ?? tool, tool_input: extra.args ?? {} } : {}),
        ...(extra.result !== undefined ? { tool_response: extra.result } : {}),
        ...(extra.prompt !== undefined ? { prompt: extra.prompt } : {}),
      }
    }
    return { event, session_id: ctx.sessionId, run_id: ctx.runId, agent: ctx.agent, workspace: ctx.workspace, ...extra }
  }

  private exec(hook: HookConfig, ctx: HookContext, payload: Record<string, unknown>): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(hook.command, { shell: true, cwd: hook.cwd ?? ctx.workspace, env: { ...process.env, ...hookEnv(ctx, payload) } })
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`hook excedeu ${hook.timeout_ms} ms`))
      }, hook.timeout_ms)
      child.stdout.on('data', (b: Buffer) => out.push(b))
      child.stderr.on('data', (b: Buffer) => err.push(b))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
      })
      child.stdin.end(JSON.stringify(payload))
    })
  }
}

/** Traduz codigo de saida e JSON do hook em decisao, no formato proprio ou no do Claude Code. */
export function interpret(hook: HookConfig, res: ExecResult): HookDecision {
  const json = parseJson(res.stdout)
  if (hook.format === 'claude-code') {
    if (res.code === 2) return { allow: false, reason: res.stderr.trim() || 'bloqueado pelo hook' }
    if (json) {
      const specific = json.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined
      if (json.decision === 'block' || specific?.permissionDecision === 'deny') {
        return { allow: false, reason: String(json.reason ?? specific?.permissionDecisionReason ?? 'bloqueado pelo hook') }
      }
    }
    return { allow: true }
  }
  if (res.code !== 0) return { allow: false, reason: res.stderr.trim() || `hook saiu com código ${res.code}` }
  if (json && json.decision === 'deny') return { allow: false, reason: String(json.reason ?? 'negado pelo hook') }
  return { allow: true, output: json && typeof json.output === 'string' ? json.output : undefined }
}

function parseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Alem do JSON no stdin, o gancho recebe os campos mais usados em variaveis de ambiente, para caber em uma linha de shell. */
function hookEnv(ctx: HookContext, payload: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_HUB_SESSION_ID: ctx.sessionId,
    AGENT_HUB_RUN_ID: ctx.runId,
    AGENT_HUB_AGENT: ctx.agent,
    AGENT_HUB_WORKSPACE: ctx.workspace,
  }
  const texto = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))
  if (payload.event !== undefined) env.AGENT_HUB_EVENT = texto(payload.event)
  if (payload.tool !== undefined) env.AGENT_HUB_TOOL = texto(payload.tool)
  if (payload.args !== undefined) {
    env.AGENT_HUB_TOOL_ARGS = texto(payload.args)
    const args = payload.args as Record<string, unknown>
    const caminho = typeof args.path === 'string' ? args.path : undefined
    if (caminho) env.AGENT_HUB_TOOL_PATH = resolve(ctx.workspace, caminho)
  }
  if (payload.stop !== undefined) env.AGENT_HUB_STOP = texto(payload.stop)
  if (payload.cost_usd !== undefined) env.AGENT_HUB_COST_USD = texto(payload.cost_usd)
  if (payload.message !== undefined) env.AGENT_HUB_MESSAGE = texto(payload.message)
  return env
}
