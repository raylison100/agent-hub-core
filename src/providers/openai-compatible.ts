import OpenAI from 'openai'
import type {
  Capabilities,
  ChatEvents,
  ChatRequest,
  ChatResult,
  Message,
  Part,
  ProviderAdapter,
  ProviderId,
  Reasoning,
  StopReason,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
  Usage,
} from '../types.js'

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool
type CompletionUsage = OpenAI.Completions.CompletionUsage

export interface OpenAICompatibleOptions {
  provider: ProviderId
  model: string
  apiKey: string
  baseURL?: string
  sendReasoningEffort?: boolean
  reasoningEffortOverride?: string
  deepseekThinking?: boolean
  temperature?: number
  seed?: number
  extraBody?: Record<string, unknown>
}

interface ReasoningRaw {
  reasoning_content?: string
}

interface UsageWithCacheFields extends CompletionUsage {
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}

interface ToolCallAccumulator {
  id: string
  name: string
  args: string
}

type OpenAIEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const effortByReasoning: Record<Reasoning, OpenAIEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

const deepseekEffort: Record<Reasoning, 'low' | 'high' | 'max'> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  max: 'max',
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly provider: ProviderId
  readonly model: string
  private readonly client: OpenAI
  private readonly opts: OpenAICompatibleOptions

  constructor(opts: OpenAICompatibleOptions) {
    this.provider = opts.provider
    this.model = opts.model
    this.opts = opts
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  }

  capabilities(): Capabilities {
    return {
      streaming: true,
      cacheControl: false,
      countTokens: false,
      reasoningLevels: this.opts.sendReasoningEffort ?? false,
      historyEditable: true,
    }
  }

  async chat(req: ChatRequest, on: ChatEvents = {}): Promise<ChatResult> {
    const started = Date.now()
    const stream = await this.client.chat.completions.create(this.buildParams(req), { signal: req.signal })
    const text: string[] = []
    const reasoning: string[] = []
    const calls = new Map<number, ToolCallAccumulator>()
    let finish: string | null = null
    let usage: UsageWithCacheFields | null = null
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage as UsageWithCacheFields
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta as typeof choice.delta & { reasoning_content?: string }
      if (delta.content) {
        text.push(delta.content)
        on.onText?.(delta.content)
      }
      if (delta.reasoning_content) {
        reasoning.push(delta.reasoning_content)
        on.onReasoning?.(delta.reasoning_content)
      }
      for (const tc of delta.tool_calls ?? []) accumulateToolCall(calls, tc)
      if (choice.finish_reason) finish = choice.finish_reason
    }
    const message = buildAssistant(text.join(''), calls, reasoning.join(''))
    return {
      message,
      toolCalls: message.parts.filter((p): p is ToolCallPart => p.type === 'tool_call'),
      stopReason: mapStop(finish, calls.size > 0),
      usage: mapOpenAICompatibleUsage(usage),
      model: this.model,
      latencyMs: Date.now() - started,
    }
  }

  private buildParams(req: ChatRequest): ChatParams {
    const params: ChatParams = {
      model: this.model,
      messages: [{ role: 'system', content: req.system }, ...toMessages(req.messages)],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxOutput,
    }
    if (req.tools.length > 0) {
      params.tools = req.tools.map(toTool)
      params.tool_choice = 'auto'
    }
    if (this.opts.sendReasoningEffort) {
      const effort = this.opts.reasoningEffortOverride ?? effortByReasoning[req.reasoning]
      params.reasoning_effort = effort as ChatParams['reasoning_effort']
    }
    if (this.opts.temperature !== undefined) params.temperature = this.opts.temperature
    if (this.opts.seed !== undefined) params.seed = this.opts.seed
    return Object.assign(params, this.deepseekParams(req.reasoning), this.opts.extraBody ?? {})
  }

  /** DeepSeek V4: raciocinio ligado por `thinking` e `reasoning_effort`; `low` no perfil desliga o raciocinio. */
  private deepseekParams(reasoning: Reasoning): Record<string, unknown> {
    if (!this.opts.deepseekThinking) return {}
    if (reasoning === 'low') return { thinking: { type: 'disabled' } }
    return { thinking: { type: 'enabled' }, reasoning_effort: deepseekEffort[reasoning] }
  }
}

/** Normaliza o usage de APIs compativeis com OpenAI, incluindo os campos de cache do DeepSeek. */
export function mapOpenAICompatibleUsage(usage: UsageWithCacheFields | null | undefined): Usage {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: true }
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    output: Math.max(0, (usage.completion_tokens ?? 0) - reasoning),
    cacheRead: cached,
    cacheWrite: 0,
    reasoning,
    missing: false,
  }
}

function accumulateToolCall(
  calls: Map<number, ToolCallAccumulator>,
  tc: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall,
): void {
  const current = calls.get(tc.index) ?? { id: '', name: '', args: '' }
  if (tc.id) current.id = tc.id
  if (tc.function?.name) current.name += tc.function.name
  if (tc.function?.arguments) current.args += tc.function.arguments
  calls.set(tc.index, current)
}

function buildAssistant(text: string, calls: Map<number, ToolCallAccumulator>, reasoning: string): Message {
  const parts: Part[] = []
  if (text.length > 0) parts.push({ type: 'text', text })
  for (const [index, call] of calls) {
    parts.push({
      type: 'tool_call',
      id: call.id || `call_${index}`,
      name: call.name,
      args: parseArgs(call.args),
      rawArgs: call.args,
    })
  }
  const message: Message = { role: 'assistant', parts }
  if (reasoning.length > 0) {
    message.raw = { reasoning_content: reasoning } satisfies ReasoningRaw
    message.rawProvider = 'openai-compatible'
  }
  return message
}

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function toTool(t: ToolDefinition): ChatTool {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }
}

function toMessages(messages: Message[]): ChatMessage[] {
  return messages.flatMap(toChatMessages)
}

function toChatMessages(m: Message): ChatMessage[] {
  if (m.role === 'assistant') return [toAssistantMessage(m)]
  if (m.role === 'tool') return m.parts.filter(isToolResult).map(toToolMessage)
  return [{ role: 'user', content: m.parts.map(partText).join('\n') }]
}

function toAssistantMessage(m: Message): ChatMessage {
  const text = m.parts.map(partText).join('')
  const toolCalls = m.parts.filter(isToolCall).map((p) => ({
    id: p.id,
    type: 'function' as const,
    function: { name: p.name, arguments: p.rawArgs ?? JSON.stringify(p.args ?? {}) },
  }))
  const message: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & ReasoningRaw = {
    role: 'assistant',
    content: text.length > 0 ? text : null,
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const raw = m.rawProvider === 'openai-compatible' ? (m.raw as ReasoningRaw | undefined) : undefined
  if (raw?.reasoning_content) message.reasoning_content = raw.reasoning_content
  return message
}

function toToolMessage(p: ToolResultPart): ChatMessage {
  return { role: 'tool', tool_call_id: p.callId, content: p.content }
}

function partText(p: Part): string {
  return p.type === 'text' ? p.text : ''
}

function isToolResult(p: Part): p is ToolResultPart {
  return p.type === 'tool_result'
}

function isToolCall(p: Part): p is ToolCallPart {
  return p.type === 'tool_call'
}

function mapStop(finish: string | null, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool'
  switch (finish) {
    case 'length':
      return 'max_output'
    case 'content_filter':
      return 'refusal'
    case 'tool_calls':
      return 'tool'
    default:
      return 'end'
  }
}
