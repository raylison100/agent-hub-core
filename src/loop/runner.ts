import type { AgentProfile } from '../agents/schema.js'
import type { Skill } from '../agents/load.js'
import { approxTokens, estimateNextInput } from '../context/estimate.js'
import { Budget, BudgetExceededError, type BudgetWarning } from '../cost/budget.js'
import type { Ledger } from '../cost/ledger.js'
import type { Pricing } from '../cost/pricing.js'
import { decide } from '../tools/policy.js'
import type { ToolRegistry } from '../tools/registry.js'
import { validateCall } from '../tools/validate.js'
import type {
  ChatResult,
  Decision,
  Message,
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
  | { type: 'run_finished'; stop: RunStop; steps: number; costUsd: number; error?: string }

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
  signal?: AbortSignal
}

export interface RunInput {
  runId: string
  sessionId: string
  history: Message[]
  userText: string
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

export class AgentRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(input: RunInput): Promise<RunResult> {
    const { profile, emit } = this.deps
    const appended: Message[] = [{ role: 'user', parts: [{ type: 'text', text: input.userText }] }]
    const messages = [...input.history, ...appended]
    const system = this.systemPrompt()
    const tools = this.toolDefinitions()
    let steps = 0
    let costUsd = 0
    let invalid = 0
    let lastInput = this.deps.ledger.lastInputTokens(input.sessionId)
    let sinceLast: Message[] = [...appended]

    for (;;) {
      if (this.deps.signal?.aborted) return this.finish('cancelled', appended, steps, costUsd)
      if (steps >= profile.max_steps) return this.finish('max_steps', appended, steps, costUsd)

      const estimatedInput = estimateNextInput(lastInput, sinceLast, messages, system)
      const budgetStop = this.checkBudget(estimatedInput)
      if (budgetStop) return this.finish('budget_exceeded', appended, steps, costUsd, budgetStop)

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
        if (this.deps.signal?.aborted) return this.finish('cancelled', appended, steps, costUsd)
        return this.finish('error', appended, steps, costUsd, describe(err))
      }

      steps += 1
      const stepCost = this.record(input, steps, result)
      costUsd += stepCost
      lastInput = result.usage.missing ? estimatedInput : result.usage.input + result.usage.cacheRead + result.usage.cacheWrite
      sinceLast = []
      messages.push(result.message)
      appended.push(result.message)
      sinceLast.push(result.message)

      if (result.stopReason === 'refusal') return this.finish('refusal', appended, steps, costUsd)
      if (result.stopReason === 'max_output') return this.finish('max_output', appended, steps, costUsd)
      if (result.stopReason !== 'tool' || result.toolCalls.length === 0) return this.finish('end', appended, steps, costUsd)

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
        if (invalid > profile.repair_attempts) return this.finish('tool_call_invalid', appended, steps, costUsd)
      }
    }
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
    const started = Date.now()
    try {
      const content = await this.invoke(def, validated.args)
      this.deps.emit({ type: 'tool_result', callId: call.id, name: def.name, content, isError: false, ms: Date.now() - started })
      return { part: { type: 'tool_result', callId: call.id, content, isError: false }, invalid: false }
    } catch (err) {
      const content = describe(err)
      this.deps.emit({ type: 'tool_result', callId: call.id, name: def.name, content, isError: true, ms: Date.now() - started })
      return { part: { type: 'tool_result', callId: call.id, content, isError: true }, invalid: false }
    }
  }

  private async invoke(def: ToolDefinition, args: Record<string, unknown>): Promise<string> {
    if (def.name === 'load_skill') return this.loadSkill(String(args.name))
    const tool = this.deps.tools.get(def.name)
    if (!tool) throw new Error(`ferramenta nao registrada: ${def.name}`)
    return tool.handler(args, { workspace: this.deps.workspace, signal: this.deps.signal })
  }

  private loadSkill(name: string): string {
    const skill = this.deps.skills.get(name)
    if (!skill || !this.deps.profile.skills.includes(name)) throw new Error(`skill nao disponivel: ${name}`)
    return skill.body
  }

  private toolDefinitions(): ToolDefinition[] {
    const { profile, tools } = this.deps
    const wanted = [...profile.tools.native, ...profile.tools.mcp.flatMap((s) => tools.names().filter((n) => n.startsWith(`${s}__`)))]
    const defs = tools.definitions(wanted)
    if (profile.skills.length > 0) defs.push(loadSkillTool)
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

  private finish(stop: RunStop, appended: Message[], steps: number, costUsd: number, error?: string): RunResult {
    this.deps.emit({ type: 'run_finished', stop, steps, costUsd, error })
    return { stop, appended, steps, costUsd, error }
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
