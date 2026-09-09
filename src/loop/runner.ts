import type { AgentProfile } from '../agents/schema.js'
import type { Skill } from '../agents/load.js'
import { compactHistory, estimateAll, needsCompaction, pruneToolResults, type Summarizer } from '../context/compact.js'
import { approxTokens, estimateNextInput } from '../context/estimate.js'
import { Budget, BudgetExceededError, type BudgetWarning } from '../cost/budget.js'
import type { Ledger } from '../cost/ledger.js'
import type { Pricing } from '../cost/pricing.js'
import type { HookContext, HookRunner } from '../hooks/runner.js'
import { decide } from '../tools/policy.js'
import type { ToolRegistry } from '../tools/registry.js'
import { validateCall } from '../tools/validate.js'
import type {
  ChatResult,
  Decision,
  Message,
  Part,
  Policy,
  ProviderAdapter,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
  Usage,
} from '../types.js'

export type RunStop =
  | 'end'
  | 'max_steps'
  | 'max_output'
  | 'budget_exceeded'
  | 'tool_call_invalid'
  | 'refusal'
  | 'cancelled'
  | 'error'

export type RunEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; call: ToolCallPart; decision: Decision }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError: boolean; ms: number }
  | { type: 'usage'; step: number; usage: Usage; costUsd: number; model: string; latencyMs: number }
  | { type: 'budget_warning'; warning: BudgetWarning }
  | { type: 'escalation'; from: string; to: string; reason: string }
  | { type: 'compaction'; mode: 'prune' | 'summary'; before: number; after: number }
  | { type: 'skills_loaded'; names: string[] }
  | { type: 'delegation'; phase: 'start' | 'end'; agent: string; runId: string; task: string; costUsd?: number; stop?: string }
  | { type: 'hook'; event: string; tool?: string; allow: boolean; reason?: string }
  | { type: 'run_finished'; stop: RunStop; steps: number; costUsd: number; error?: string }

export interface DelegationResult {
  text: string
  costUsd: number
  runId: string
  stop: string
}

export interface RunnerDeps {
  adapter: ProviderAdapter
  profile: AgentProfile
  tools: ToolRegistry
  skills: Map<string, Skill>
  policy: Policy
  pricing: Pricing
  ledger: Ledger
  budget: Budget
  workspace: string
  approve: (call: ToolCallPart, def: ToolDefinition) => Promise<'allow' | 'deny'>
  emit: (event: RunEvent) => void
  summarize?: Summarizer
  redact?: (text: string) => string
  preloadSkills?: Skill[]
  delegate?: (agent: string, task: string) => Promise<DelegationResult>
  hooks?: HookRunner
  signal?: AbortSignal
}

export interface RunInput {
  runId: string
  sessionId: string
  history: Message[]
  userText: string
  parentRunId?: string
}

export interface RunResult {
  stop: RunStop
  appended: Message[]
  steps: number
  costUsd: number
  error?: string
}

const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description: 'Carrega as instrucoes completas de uma skill listada no prompt de sistema.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
}

function delegateTool(agents: string[]): ToolDefinition {
  return {
    name: 'delegate',
    description:
      'Delega uma subtarefa a outro agente, mais barato ou mais especializado, e recebe apenas a resposta final dele. Use para leitura extensa, busca e resumo.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: agents },
        task: { type: 'string', description: 'Tarefa completa e autocontida, com caminhos e criterio de pronto.' },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
  }
}

export class AgentRunner {
  private steps = 0
  private costUsd = 0
  private hookCtx!: HookContext

  constructor(private readonly deps: RunnerDeps) {}

  async run(input: RunInput): Promise<RunResult> {
    const { profile, emit } = this.deps
    this.hookCtx = { sessionId: input.sessionId, runId: input.runId, agent: profile.name, workspace: this.deps.workspace }
    const system = this.systemPrompt()
    const tools = this.toolDefinitions()
    const userMessage = this.userMessage(input.userText)
    let appended: Message[] = [userMessage]
    let messages = [...input.history, userMessage]
    let invalid = 0
    let lastInput = this.deps.ledger.lastInputTokens(input.sessionId)
    let sinceLast: Message[] = [...appended]

    const gate = await this.runStartHook(input.userText)
    if (gate) return this.finish('error', appended, gate)

    const compacted = await this.compactIfNeeded(system, messages, input.history, lastInput, sinceLast)
    if (compacted) {
      messages = compacted
      appended = compacted
      lastInput = null
      sinceLast = []
    }

    for (;;) {
      if (this.deps.signal?.aborted) return this.finish('cancelled', appended)
      if (this.steps >= profile.max_steps) return this.finish('max_steps', appended)

      const estimatedInput = estimateNextInput(lastInput, sinceLast, messages, system)
      const budgetStop = this.checkBudget(estimatedInput)
      if (budgetStop) return this.finish('budget_exceeded', appended, budgetStop)

      let result: ChatResult
      try {
        result = await this.deps.adapter.chat(
          {
            system,
            messages,
            tools,
            maxOutput: profile.max_output,
            reasoning: profile.reasoning,
            systemCacheTtl: profile.cache.system_ttl,
            providerOptions: profile.provider_options,
            signal: this.deps.signal,
          },
          {
            onText: (delta) => emit({ type: 'text_delta', delta }),
            onReasoning: (delta) => emit({ type: 'reasoning_delta', delta }),
          },
        )
      } catch (err) {
        if (this.deps.signal?.aborted) return this.finish('cancelled', appended)
        return this.finish('error', appended, describe(err))
      }

      this.steps += 1
      this.costUsd += this.record(input, this.steps, result)
      lastInput = result.usage.missing ? estimatedInput : result.usage.input + result.usage.cacheRead + result.usage.cacheWrite
      sinceLast = []
      messages.push(result.message)
      appended.push(result.message)
      sinceLast.push(result.message)

      if (result.stopReason === 'refusal') return this.finish('refusal', appended)
      if (result.stopReason === 'max_output') return this.finish('max_output', appended)
      if (result.stopReason !== 'tool' || result.toolCalls.length === 0) return this.finish('end', appended)

      const results: ToolResultPart[] = []
      let anyInvalid = false
      for (const call of result.toolCalls) {
        const outcome = await this.executeCall(call, tools)
        if (outcome.invalid) anyInvalid = true
        results.push(outcome.part)
      }
      const toolMessage: Message = { role: 'tool', parts: results }
      messages.push(toolMessage)
      appended.push(toolMessage)
      sinceLast.push(toolMessage)

      if (anyInvalid) {
        invalid += 1
        if (invalid > profile.repair_attempts) return this.finish('tool_call_invalid', appended)
      }
    }
  }

  private async runStartHook(text: string): Promise<string | undefined> {
    const { hooks, emit } = this.deps
    if (!hooks || hooks.size === 0) return undefined
    const decision = await hooks.runStart(this.hookCtx, text)
    if (!decision.allow) {
      emit({ type: 'hook', event: 'run.start', allow: false, reason: decision.reason })
      return `bloqueado por hook: ${decision.reason ?? 'sem motivo'}`
    }
    return undefined
  }

  private async compactIfNeeded(
    system: string,
    messages: Message[],
    history: Message[],
    lastInput: number | null,
    sinceLast: Message[],
  ): Promise<Message[] | null> {
    const { profile, adapter, summarize, emit } = this.deps
    const policy = { window: profile.context.window, compactAt: profile.context.compact_at }
    let estimate = estimateNextInput(lastInput, sinceLast, messages, system)
    if (!needsCompaction(estimate, policy) || history.length === 0) return null
    let current = messages
    if (adapter.capabilities().historyEditable) {
      current = pruneToolResults(current)
      const after = estimateAll(system, current)
      emit({ type: 'compaction', mode: 'prune', before: estimate, after })
      estimate = after
    }
    if (needsCompaction(estimate, policy) && summarize) {
      current = await compactHistory(current, summarize)
      emit({ type: 'compaction', mode: 'summary', before: estimate, after: estimateAll(system, current) })
    }
    return current
  }

  private async executeCall(call: ToolCallPart, defs: ToolDefinition[]): Promise<{ part: ToolResultPart; invalid: boolean }> {
    const def = defs.find((d) => d.name === call.name)
    if (!def) return { part: errorResult(call, `ferramenta desconhecida: ${call.name}`), invalid: true }
    const validated = validateCall(def, call.rawArgs ?? call.args)
    if (!validated.ok) {
      this.deps.emit({ type: 'tool_call', call, decision: 'deny' })
      return { part: errorResult(call, validated.error), invalid: true }
    }
    const decision = decide(this.deps.policy, def, validated.args)
    this.deps.emit({ type: 'tool_call', call: { ...call, args: validated.args }, decision })
    if (decision === 'deny') return { part: errorResult(call, `ferramenta ${def.name} negada pela politica`), invalid: false }
    if (decision === 'ask') {
      const answer = await this.deps.approve({ ...call, args: validated.args }, def)
      if (answer === 'deny') return { part: errorResult(call, `ferramenta ${def.name} negada pelo usuario`), invalid: false }
    }
    const blocked = await this.beforeHook(def.name, validated.args)
    if (blocked) return { part: errorResult(call, blocked), invalid: false }
    const started = Date.now()
    try {
      const raw = await this.invoke(def, validated.args)
      const content = this.clean(await this.afterHook(def.name, validated.args, raw))
      this.deps.emit({ type: 'tool_result', callId: call.id, name: def.name, content, isError: false, ms: Date.now() - started })
      return { part: { type: 'tool_result', callId: call.id, content, isError: false }, invalid: false }
    } catch (err) {
      const content = this.clean(describe(err))
      this.deps.emit({ type: 'tool_result', callId: call.id, name: def.name, content, isError: true, ms: Date.now() - started })
      return { part: { type: 'tool_result', callId: call.id, content, isError: true }, invalid: false }
    }
  }

  private async beforeHook(tool: string, args: Record<string, unknown>): Promise<string | undefined> {
    const { hooks, emit } = this.deps
    if (!hooks || hooks.size === 0) return undefined
    const decision = await hooks.before(this.hookCtx, tool, args)
    if (decision.allow) return undefined
    emit({ type: 'hook', event: 'tool.before', tool, allow: false, reason: decision.reason })
    return `ferramenta ${tool} bloqueada por hook: ${decision.reason ?? 'sem motivo'}`
  }

  private async afterHook(tool: string, args: Record<string, unknown>, result: string): Promise<string> {
    const { hooks } = this.deps
    if (!hooks || hooks.size === 0) return result
    return hooks.after(this.hookCtx, tool, args, result)
  }

  private clean(text: string): string {
    return this.deps.redact ? this.deps.redact(text) : text
  }

  private async invoke(def: ToolDefinition, args: Record<string, unknown>): Promise<string> {
    if (def.name === 'load_skill') return this.loadSkill(String(args.name))
    if (def.name === 'delegate') return this.delegate(String(args.agent), String(args.task))
    const tool = this.deps.tools.get(def.name)
    if (!tool) throw new Error(`ferramenta nao registrada: ${def.name}`)
    return tool.handler(args, { workspace: this.deps.workspace, signal: this.deps.signal })
  }

  private async delegate(agent: string, task: string): Promise<string> {
    const { profile, delegate, emit } = this.deps
    if (!delegate) throw new Error('delegacao nao disponivel neste daemon')
    if (!profile.delegates.includes(agent)) throw new Error(`agente ${agent} nao esta em delegates`)
    emit({ type: 'delegation', phase: 'start', agent, runId: '', task })
    const result = await delegate(agent, task)
    this.costUsd += result.costUsd
    emit({ type: 'delegation', phase: 'end', agent, runId: result.runId, task, costUsd: result.costUsd, stop: result.stop })
    return `[resposta de ${agent}, custo ${result.costUsd.toFixed(4)} USD, parada ${result.stop}]\n${result.text}`
  }

  private loadSkill(name: string): string {
    const skill = this.deps.skills.get(name)
    if (!skill || !this.deps.profile.skills.includes(name)) throw new Error(`skill nao disponivel: ${name}`)
    this.deps.emit({ type: 'skills_loaded', names: [name] })
    return skill.body
  }

  private userMessage(text: string): Message {
    const parts: Part[] = [{ type: 'text', text }]
    const preload = this.deps.preloadSkills ?? []
    for (const s of preload) parts.push({ type: 'text', text: `Instrucoes da skill ${s.name}, ativada por regra:\n\n${s.body}` })
    if (preload.length > 0) this.deps.emit({ type: 'skills_loaded', names: preload.map((s) => s.name) })
    return { role: 'user', parts }
  }

  private toolDefinitions(): ToolDefinition[] {
    const { profile, tools } = this.deps
    const wanted = [...profile.tools.native, ...profile.tools.mcp.flatMap((s) => tools.names().filter((n) => n.startsWith(`${s}__`)))]
    const defs = tools.definitions(wanted)
    if (profile.skills.length > 0) defs.push(loadSkillTool)
    if (profile.delegates.length > 0 && this.deps.delegate) defs.push(delegateTool(profile.delegates))
    return defs.sort((a, b) => a.name.localeCompare(b.name))
  }

  private systemPrompt(): string {
    const { profile, skills } = this.deps
    const available = profile.skills
      .map((n) => skills.get(n))
      .filter((s): s is Skill => s !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (available.length === 0) return profile.system
    const list = available.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    return `${profile.system}\n\nSkills disponiveis. Carregue com load_skill quando a tarefa pedir:\n${list}`
  }

  private checkBudget(estimatedInput: number): string | undefined {
    const { adapter, pricing, profile, budget, emit } = this.deps
    const estimate: Usage = { input: estimatedInput, output: profile.max_output, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false }
    let estimatedUsd: number
    try {
      estimatedUsd = pricing.cost(adapter.provider, adapter.model, estimate)
    } catch (err) {
      return describe(err)
    }
    try {
      for (const warning of budget.check(estimatedUsd)) emit({ type: 'budget_warning', warning })
    } catch (err) {
      if (err instanceof BudgetExceededError) return err.message
      throw err
    }
    return undefined
  }

  private record(input: RunInput, step: number, result: ChatResult): number {
    const { adapter, pricing, ledger, profile, emit } = this.deps
    const costUsd = pricing.cost(adapter.provider, result.model, result.usage)
    ledger.record({
      ts: Date.now(),
      sessionId: input.sessionId,
      runId: input.runId,
      parentRunId: input.parentRunId,
      step,
      agent: profile.name,
      provider: adapter.provider,
      model: result.model,
      usage: result.usage,
      costUsd,
      pricingVersion: pricing.version,
      latencyMs: result.latencyMs,
      stopReason: result.stopReason,
    })
    emit({ type: 'usage', step, usage: result.usage, costUsd, model: result.model, latencyMs: result.latencyMs })
    return costUsd
  }

  private finish(stop: RunStop, appended: Message[], error?: string): RunResult {
    const summary = { stop, steps: this.steps, cost_usd: this.costUsd, error }
    this.deps.emit({ type: 'run_finished', stop, steps: this.steps, costUsd: this.costUsd, error })
    if (this.deps.hooks && this.deps.hooks.size > 0) {
      void this.deps.hooks.runEnd(this.hookCtx, summary)
      if (stop === 'budget_exceeded') void this.deps.hooks.budgetExceeded(this.hookCtx, summary)
    }
    return { stop, appended, steps: this.steps, costUsd: this.costUsd, error }
  }
}

/** Monta os limites de orcamento de um run a partir do perfil e do arquivo de orcamentos. */
export function budgetFor(
  ledger: Ledger,
  profile: AgentProfile,
  ids: { runId: string; sessionId: string },
  agentDayUsd?: number,
  globalMonthUsd?: number,
): Budget {
  return new Budget(
    ledger,
    {
      runUsd: profile.budget.run_usd,
      sessionUsd: profile.budget.session_usd,
      agentDayUsd,
      globalMonthUsd,
    },
    { runId: ids.runId, sessionId: ids.sessionId, agent: profile.name },
  )
}

function errorResult(call: ToolCallPart, message: string): ToolResultPart {
  return { type: 'tool_result', callId: call.id, content: message, isError: true }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { approxTokens }
