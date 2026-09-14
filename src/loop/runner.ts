import type { AgentProfile } from '../agents/schema.js'
import type { Skill } from '../agents/load.js'
import { compactHistory, estimateAll, needsCompaction, pruneToolResults, withoutRepeatedToolMessages, type Summarizer } from '../context/compact.js'
import { approxTokens, estimateNextInput } from '../context/estimate.js'
import { Budget, BudgetExceededError, type BudgetWarning } from '../cost/budget.js'
import type { Ledger } from '../cost/ledger.js'
import type { Pricing } from '../cost/pricing.js'
import type { HookContext, HookRunner } from '../hooks/runner.js'
import type { ScoredAgent } from '../agents/scoring.js'
import { decide } from '../tools/policy.js'
import type { SandboxOptions, ToolRegistry } from '../tools/registry.js'
import { selectTools } from '../tools/select.js'
import { validateCall } from '../tools/validate.js'
import type {
  ChatResult,
  Decision,
  Message,
  ImageInput,
  Part,
  Policy,
  ProviderAdapter,
  Reasoning,
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

export type RoutedBy = 'rule' | 'classifier' | 'score' | 'default' | 'fixed' | 'override' | 'cascade'

export type RunEvent =
  | { type: 'user_message'; text: string; images: { mediaType: string; name?: string; ref?: string }[] }
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; call: ToolCallPart; decision: Decision }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError: boolean; ms: number }
  | { type: 'usage'; step: number; usage: Usage; costUsd: number; model: string; latencyMs: number }
  | { type: 'budget_warning'; warning: BudgetWarning }
  | { type: 'escalation'; from: string; to: string; reason: string }
  | { type: 'verification'; agent: string; ok: boolean; failures: { check: string; reason: string }[]; citations: number }
  | { type: 'compaction'; mode: 'prune' | 'summary'; before: number; after: number }
  | { type: 'max_output_retry'; reasoningTokens: number; maxOutput: number; reasoning: Reasoning }
  | { type: 'skills_loaded'; names: string[] }
  | { type: 'workspace_context'; instructions: string[]; memories: string[]; inHistory: string[]; tokens: number; ignored: { name: string; reason: string }[] }
  | { type: 'knowledge_indexed'; files: number; chunks: number; ignored: string[] }
  | { type: 'mcp_skipped'; servers: { name: string; reason: string }[] }
  | { type: 'tools_selected'; kept: number; dropped: number; tokens: number; budget: number; reused: boolean }
  | {
      type: 'delegation'
      phase: 'start' | 'end'
      agent: string
      runId: string
      task: string
      taskId?: string
      background?: boolean
      costUsd?: number
      stop?: string
      worktree?: { path: string; branch: string }
    }
  | { type: 'hook'; event: string; tool?: string; allow: boolean; reason?: string }
  | { type: 'phase'; index: number; name: string; tools: string[] }
  | { type: 'routed'; agent: string; model: string; by: RoutedBy; intent: string | null; reason: string; ranking?: ScoredAgent[]; role?: string }
  | { type: 'prompt_improved'; by: string; original: string; improved: string; costUsd: number }
  | { type: 'run_finished'; stop: RunStop; steps: number; costUsd: number; error?: string }

export interface DelegationResult {
  text: string
  costUsd: number
  runId: string
  stop: string
  taskId?: string
  agent?: string
  worktree?: { path: string; branch: string }
}

export interface DelegationOptions {
  worktree?: boolean
}

export interface SpawnHandle {
  taskId: string
  runId: string
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
  workspaceContext?: string
  turnContext?: string
  toolSet?: { previous?: string[]; save: (names: string[]) => void }
  delegate?: (agent: string, task: string, opts: DelegationOptions) => Promise<DelegationResult>
  spawn?: (agent: string, task: string, opts: DelegationOptions) => Promise<SpawnHandle>
  collect?: (taskId: string | undefined, wait: boolean) => Promise<DelegationResult[]>
  pendingSpawns?: () => number
  hooks?: HookRunner
  sandbox?: SandboxOptions
  signal?: AbortSignal
}

export interface RunInput {
  runId: string
  sessionId: string
  history: Message[]
  userText: string
  images?: ImageInput[]
  parentRunId?: string
}

export interface RunResult {
  stop: RunStop
  appended: Message[]
  steps: number
  costUsd: number
  error?: string
}

/** Instrucoes da skill com as variaveis de pasta trocadas pelos caminhos e a indicacao de onde ficam os arquivos dela. */
export function skillInstructions(skill: Skill): string {
  const raiz = skill.root ?? skill.dir
  const corpo = skill.body
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.dir)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, raiz)
  const pastas = skill.root ? `Pasta desta skill: ${skill.dir}\nPasta do plugin: ${skill.root}` : `Pasta desta skill: ${skill.dir}`
  return `${pastas}\nCaminhos relativos citados abaixo (assets/, references/, scripts/, <skill>) partem da pasta da skill: leia com read_file ou list_dir pelo caminho absoluto e rode scripts com o caminho absoluto. Os arquivos que voce criar vao no workspace.\n\n${corpo}`
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

const signalTools: ToolDefinition[] = ['plan', 'done'].map((name) => ({
  name,
  description:
    name === 'plan'
      ? 'Sinaliza que a fase de entendimento terminou. Informe o plano em summary.'
      : 'Sinaliza que a fase atual terminou. Informe em summary o que foi feito.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
  },
}))

function delegateTool(agents: string[]): ToolDefinition {
  return {
    name: 'delegate',
    description:
      'Delega uma subtarefa a outro agente e espera a resposta final dele. Varias chamadas de delegate na mesma resposta rodam em paralelo. ' +
      'Com worktree=true o subagente trabalha em uma copia isolada do repositorio, em branch propria, sem tocar nos seus arquivos.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: agents },
        task: { type: 'string', description: 'Tarefa completa e autocontida, com caminhos e criterio de pronto.' },
        worktree: { type: 'boolean', default: false },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
  }
}

function spawnTool(agents: string[]): ToolDefinition {
  return {
    name: 'spawn',
    description:
      'Inicia um subagente em segundo plano e devolve um task_id na hora, sem esperar. Continue trabalhando e chame collect para receber os resultados. ' +
      'Com worktree=true o subagente edita em uma copia isolada do repositorio, em branch propria.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: agents },
        task: { type: 'string', description: 'Tarefa completa e autocontida, com caminhos e criterio de pronto.' },
        worktree: { type: 'boolean', default: false },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
  }
}

const collectTool: ToolDefinition = {
  name: 'collect',
  description: 'Recebe resultados de subagentes iniciados com spawn. Sem task_id devolve todos; com wait=true espera os pendentes terminarem.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      wait: { type: 'boolean', default: true },
    },
    additionalProperties: false,
  },
}

export class AgentRunner {
  private steps = 0
  private costUsd = 0
  private hookCtx!: HookContext
  private phaseIndex = 0
  private phaseSteps = 0
  private phasesDone = false
  private outputBoost = 0
  private loweredReasoning: Reasoning | null = null
  private maxOutputRetried = false

  constructor(private readonly deps: RunnerDeps) {}

  async run(input: RunInput): Promise<RunResult> {
    const { profile, emit } = this.deps
    this.hookCtx = { sessionId: input.sessionId, runId: input.runId, agent: profile.name, workspace: this.deps.workspace }
    const baseSystem = this.systemPrompt()
    const escolha = selectTools(this.toolDefinitions(), input.userText, profile.context.window, undefined, this.deps.toolSet?.previous)
    const allTools = escolha.tools
    if (escolha.dropped > 0) {
      emit({ type: 'tools_selected', kept: allTools.length, dropped: escolha.dropped, tokens: escolha.used, budget: escolha.budget, reused: escolha.reused })
      if (!escolha.reused) this.deps.toolSet?.save(escolha.mcp)
    }
    this.announcePhase(allTools)
    const userMessage = this.userMessage(input.userText, input.images)
    this.deps.emit({ type: 'user_message', text: input.userText, images: (input.images ?? []).map((i) => ({ mediaType: i.mediaType, name: i.name, ref: i.ref })) })
    let appended: Message[] = [userMessage]
    let messages = [...withoutRepeatedToolMessages(input.history), userMessage]
    let invalid = 0
    let lastInput = this.deps.ledger.lastInputTokens(input.sessionId)
    let sinceLast: Message[] = [...appended]

    const gate = await this.runStartHook(input.userText)
    if (gate) return this.finish('error', appended, gate)

    const compacted = await this.compactIfNeeded(baseSystem, messages, input.history, lastInput, sinceLast)
    if (compacted) {
      messages = compacted
      appended = compacted[0]?.kind === 'compaction' ? [...compacted] : [userMessage]
      lastInput = null
      sinceLast = []
    }

    for (;;) {
      if (this.deps.signal?.aborted) return this.finish('cancelled', appended)
      if (this.steps >= profile.max_steps) return this.finish('max_steps', appended)
      if (this.phasesDone) return this.finish('end', appended)

      const system = this.phaseSystem(baseSystem)
      const tools = this.phaseTools(allTools)
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
            maxOutput: profile.max_output + this.outputBoost,
            reasoningBudget: profile.reasoning_budget,
            reasoning: this.loweredReasoning ?? profile.reasoning,
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
      this.phaseSteps += 1
      this.costUsd += this.record(input, this.steps, result)
      lastInput = result.usage.missing ? estimatedInput : result.usage.input + result.usage.cacheRead + result.usage.cacheWrite
      sinceLast = []
      messages.push(result.message)
      appended.push(result.message)
      sinceLast.push(result.message)

      if (result.stopReason === 'refusal') return this.finish('refusal', appended)
      if (result.stopReason === 'max_output') {
        const retry = this.retryAfterMaxOutput(result)
        if (!retry) return this.finish('max_output', appended)
        for (const list of new Set([messages, appended, sinceLast])) {
          if (list[list.length - 1] === result.message) list.pop()
        }
        emit({ type: 'max_output_retry', reasoningTokens: result.usage.reasoning, maxOutput: retry.maxOutput, reasoning: retry.reasoning })
        continue
      }
      if (result.stopReason !== 'tool' || result.toolCalls.length === 0) {
        const pending = this.deps.pendingSpawns?.() ?? 0
        if (pending === 0) return this.finish('end', appended)
        const reminder: Message = {
          role: 'user',
          parts: [{ type: 'text', text: `Ainda ha ${pending} subagente(s) em segundo plano. Chame collect com wait=true, use os resultados e so entao conclua.` }],
        }
        messages.push(reminder)
        appended.push(reminder)
        sinceLast.push(reminder)
        continue
      }

      const outcomes = await Promise.all(result.toolCalls.map((call) => this.executeCall(call, tools)))
      const results: ToolResultPart[] = []
      let anyInvalid = false
      for (const [i, outcome] of outcomes.entries()) {
        if (outcome.invalid) anyInvalid = true
        results.push(outcome.part)
        if (!outcome.part.isError) this.advancePhase(result.toolCalls[i]!.name, allTools)
      }
      const toolMessage: Message = { role: 'tool', parts: results }
      messages.push(toolMessage)
      appended.push(toolMessage)
      sinceLast.push(toolMessage)

      if (anyInvalid) {
        invalid += 1
        if (invalid > profile.repair_attempts) return this.finish('tool_call_invalid', appended)
      }
      this.advancePhaseBySteps(allTools)
    }
  }

  private phaseTools(all: ToolDefinition[]): ToolDefinition[] {
    const phase = this.currentPhase()
    if (!phase) return all
    const allowed = new Set(phase.tools)
    const chosen = all.filter((t) => allowed.has(t.name))
    const signal = phase.until.tool_called
    if (signal && !chosen.some((t) => t.name === signal)) {
      const def = signalTools.find((t) => t.name === signal)
      if (def) chosen.push(def)
    }
    return chosen.sort((a, b) => a.name.localeCompare(b.name))
  }

  private phaseSystem(base: string): string {
    const phase = this.currentPhase()
    if (!phase) return base
    const signal = phase.until.tool_called ? `Ao concluir esta fase, chame a ferramenta ${phase.until.tool_called}.` : ''
    const limit = phase.until.max_steps ? `Esta fase termina sozinha em ${phase.until.max_steps} passos.` : ''
    return `${base}\n\nFase atual: ${phase.name}. ${phase.instructions ?? ''} ${signal} ${limit}`.trim()
  }

  private currentPhase() {
    const phases = this.deps.profile.phases
    if (!phases || phases.length === 0 || this.phasesDone) return undefined
    return phases[this.phaseIndex]
  }

  private advancePhase(toolName: string, all: ToolDefinition[]): void {
    const phase = this.currentPhase()
    if (!phase || phase.until.tool_called !== toolName) return
    this.nextPhase(all)
  }

  private advancePhaseBySteps(all: ToolDefinition[]): void {
    const phase = this.currentPhase()
    if (!phase || !phase.until.max_steps || this.phaseSteps < phase.until.max_steps) return
    this.nextPhase(all)
  }

  private nextPhase(all: ToolDefinition[]): void {
    const phases = this.deps.profile.phases ?? []
    this.phaseIndex += 1
    this.phaseSteps = 0
    if (this.phaseIndex >= phases.length) {
      this.phasesDone = true
      return
    }
    this.announcePhase(all)
  }

  private announcePhase(all: ToolDefinition[]): void {
    const phase = this.currentPhase()
    if (!phase) return
    this.deps.emit({ type: 'phase', index: this.phaseIndex, name: phase.name, tools: this.phaseTools(all).map((t) => t.name) })
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

  /** Redige segredo e corta o que nao cabe: resultado gigante em janela pequena mata o run no passo seguinte. */
  private clean(text: string): string {
    const limpo = this.deps.redact ? this.deps.redact(text) : text
    return capToolResult(limpo, this.toolResultCap())
  }

  /** Teto do resultado de uma ferramenta: um quarto da janela do modelo, nunca mais que 4000 tokens. */
  private toolResultCap(): number {
    return Math.max(400, Math.min(4000, Math.floor(this.deps.profile.context.window * 0.25)))
  }

  private async invoke(def: ToolDefinition, args: Record<string, unknown>): Promise<string> {
    if (def.name === 'load_skill') return this.loadSkill(String(args.name))
    if (def.name === 'delegate') return this.delegate(String(args.agent), String(args.task), { worktree: args.worktree === true })
    if (def.name === 'spawn') return this.spawn(String(args.agent), String(args.task), { worktree: args.worktree === true })
    if (def.name === 'collect') return this.collect(typeof args.task_id === 'string' ? args.task_id : undefined, args.wait !== false)
    if (def.name === 'plan' || def.name === 'done') return `registrado: ${String(args.summary).slice(0, 200)}`
    const tool = this.deps.tools.get(def.name)
    if (!tool) throw new Error(`ferramenta nao registrada: ${def.name}`)
    return tool.handler(args, { workspace: this.deps.workspace, runId: this.hookCtx.runId, sessionId: this.hookCtx.sessionId, agent: this.deps.profile.name, signal: this.deps.signal, sandbox: this.deps.sandbox, readRoots: this.skillRoots() })
  }

  private async delegate(agent: string, task: string, opts: DelegationOptions): Promise<string> {
    const { profile, delegate } = this.deps
    if (!delegate) throw new Error('delegacao nao disponivel neste daemon')
    if (!profile.delegates.includes(agent)) throw new Error(`agente ${agent} nao esta em delegates`)
    const result = await delegate(agent, task, opts)
    this.costUsd += result.costUsd
    return renderDelegation(result, agent)
  }

  private async spawn(agent: string, task: string, opts: DelegationOptions): Promise<string> {
    const { profile, spawn } = this.deps
    if (!spawn) throw new Error('spawn nao disponivel neste daemon')
    if (!profile.delegates.includes(agent)) throw new Error(`agente ${agent} nao esta em delegates`)
    const handle = await spawn(agent, task, opts)
    return `subagente ${agent} iniciado em segundo plano, task_id ${handle.taskId}. Continue e chame collect para receber o resultado.`
  }

  private async collect(taskId: string | undefined, wait: boolean): Promise<string> {
    const { collect } = this.deps
    if (!collect) throw new Error('collect nao disponivel neste daemon')
    const results = await collect(taskId, wait)
    for (const r of results) this.costUsd += r.costUsd
    if (results.length === 0) return wait ? 'nenhum subagente pendente' : 'nenhum resultado pronto ainda; chame collect com wait=true para esperar'
    return results.map((r) => `task_id ${r.taskId ?? '?'}\n${renderDelegation(r, r.agent ?? 'subagente')}`).join('\n\n')
  }

  private loadSkill(name: string): string {
    const skill = this.deps.skills.get(name)
    if (!skill || !this.deps.profile.skills.includes(name)) throw new Error(`skill nao disponivel: ${name}`)
    this.deps.emit({ type: 'skills_loaded', names: [name] })
    return skillInstructions(skill)
  }

  /** Pastas das skills deste agente, liberadas para leitura pelo caminho absoluto. */
  private skillRoots(): string[] {
    const { profile, skills, preloadSkills } = this.deps
    const lista = [...profile.skills.map((n) => skills.get(n)), ...(preloadSkills ?? [])].filter((s): s is Skill => s !== undefined)
    return [...new Set(lista.map((s) => s.root ?? s.dir))]
  }

  private userMessage(text: string, images: ImageInput[] = []): Message {
    const parts: Part[] = [{ type: 'text', text }]
    for (const img of images) parts.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name })
    if (this.deps.turnContext) parts.push({ type: 'text', text: this.deps.turnContext, context: true })
    const preload = this.deps.preloadSkills ?? []
    for (const s of preload) parts.push({ type: 'text', text: `Instrucoes da skill ${s.name}, ativada por regra:\n\n${skillInstructions(s)}`, context: true })
    if (preload.length > 0) this.deps.emit({ type: 'skills_loaded', names: preload.map((s) => s.name) })
    return { role: 'user', parts }
  }

  private toolDefinitions(): ToolDefinition[] {
    const { profile, tools } = this.deps
    const wanted = [...profile.tools.native, ...profile.tools.mcp.flatMap((s) => tools.names().filter((n) => n.startsWith(`${s}__`)))]
    const defs = tools.definitions(wanted)
    if (profile.skills.length > 0) defs.push(loadSkillTool)
    if (profile.delegates.length > 0 && this.deps.delegate) defs.push(delegateTool(profile.delegates))
    if (profile.delegates.length > 0 && this.deps.spawn && this.deps.collect) defs.push(spawnTool(profile.delegates), collectTool)
    for (const phase of profile.phases ?? []) {
      for (const name of phase.tools) {
        const signal = signalTools.find((t) => t.name === name)
        if (signal && !defs.some((d) => d.name === name)) defs.push(signal)
      }
    }
    return defs.sort((a, b) => a.name.localeCompare(b.name))
  }

  private systemPrompt(): string {
    const { profile, skills, workspaceContext } = this.deps
    const available = profile.skills
      .map((n) => skills.get(n))
      .filter((s): s is Skill => s !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
    const blocos = [profile.system]
    if (available.length > 0) {
      blocos.push(`Skills disponiveis. Carregue com load_skill quando a tarefa pedir:\n${available.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`)
    }
    if (workspaceContext) blocos.push(workspaceContext)
    return blocos.join('\n\n')
  }

  /** Passo que estourou o teto sem escrever nada: o raciocinio comeu a saida, entao repete uma vez com teto maior e esforco menor. */
  private retryAfterMaxOutput(result: ChatResult): { maxOutput: number; reasoning: Reasoning } | null {
    const { profile } = this.deps
    if (this.maxOutputRetried || result.toolCalls.length > 0) return null
    if (result.message.parts.some((p) => p.type === 'text' && p.text.trim() !== '')) return null
    this.maxOutputRetried = true
    this.outputBoost = profile.max_output
    this.loweredReasoning = lowerReasoning(this.loweredReasoning ?? profile.reasoning)
    return { maxOutput: profile.max_output + this.outputBoost, reasoning: this.loweredReasoning }
  }

  private checkBudget(estimatedInput: number): string | undefined {
    const { adapter, pricing, profile, budget, emit } = this.deps
    const estimate: Usage = { input: estimatedInput, output: profile.max_output + this.outputBoost, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false }
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

function renderDelegation(r: DelegationResult, agent: string): string {
  const where = r.worktree ? `, worktree ${r.worktree.path} na branch ${r.worktree.branch}` : ''
  return `[resposta de ${agent}, custo ${r.costUsd.toFixed(4)} USD, parada ${r.stop}${where}]\n${r.text}`
}

function errorResult(call: ToolCallPart, message: string): ToolResultPart {
  return { type: 'tool_result', callId: call.id, content: message, isError: true }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { approxTokens }

const nextLowerReasoning: Record<Reasoning, Reasoning> = { max: 'high', high: 'medium', medium: 'low', low: 'low' }

/** Um degrau abaixo no esforco de raciocinio, para a repeticao sobrar espaco de resposta. */
function lowerReasoning(current: Reasoning): Reasoning {
  return nextLowerReasoning[current]
}

/** Corta o resultado no teto de tokens, dizendo ao modelo que foi cortado e como pedir menos da proxima vez. */
export function capToolResult(text: string, maxTokens: number): string {
  const limite = maxTokens * 4
  if (text.length <= limite) return text
  const cortado = text.slice(0, limite)
  return `${cortado}\n[resultado cortado em ~${maxTokens} tokens de ${approxTokens(text)}. Peca menos itens, use filtro ou paginacao para ver o resto.]`
}
