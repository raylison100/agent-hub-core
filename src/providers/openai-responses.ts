import OpenAI from 'openai'
import type {
  Capabilities,
  ChatEvents,
  ChatRequest,
  ChatResult,
  Message,
  Part,
  ProviderAdapter,
  Reasoning,
  StopReason,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart,
  Usage,
} from '../types.js'

type Params = OpenAI.Responses.ResponseCreateParamsStreaming
type InputItem = OpenAI.Responses.ResponseInputItem
type OutputItem = OpenAI.Responses.ResponseOutputItem
type ResponseUsage = OpenAI.Responses.ResponseUsage

export interface OpenAIResponsesOptions {
  model: string
  apiKey: string
  baseURL?: string
  reasoningEffortOverride?: string
  temperature?: number
  extraBody?: Record<string, unknown>
}

interface ResponsesRaw {
  output: OutputItem[]
}

const effortByReasoning: Record<Reasoning, 'low' | 'medium' | 'high' | 'max'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

/** Adaptador da Responses API da OpenAI, a unica que aceita raciocinio junto com ferramentas. Os itens de raciocinio voltam cifrados e sao reenviados na proxima chamada. */
export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const
  readonly model: string
  private readonly client: OpenAI
  private readonly opts: OpenAIResponsesOptions

  constructor(opts: OpenAIResponsesOptions) {
    this.model = opts.model
    this.opts = opts
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })
  }

  capabilities(): Capabilities {
    return {
      streaming: true,
      cacheControl: false,
      countTokens: false,
      reasoningLevels: true,
      historyEditable: true,
    }
  }

  async chat(req: ChatRequest, on: ChatEvents = {}): Promise<ChatResult> {
    const started = Date.now()
    const stream = await this.client.responses.create(this.buildParams(req), { signal: req.signal })
    let output: OutputItem[] = []
    let usage: ResponseUsage | null = null
    let incomplete: string | null = null
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') on.onText?.(event.delta)
      if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') on.onReasoning?.(event.delta)
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        output = event.response.output
        usage = event.response.usage ?? null
        incomplete = event.response.incomplete_details?.reason ?? null
      }
      if (event.type === 'response.failed') throw new Error(event.response.error?.message ?? 'resposta falhou na OpenAI')
    }
    const message = buildAssistant(output)
    const toolCalls = message.parts.filter((p): p is ToolCallPart => p.type === 'tool_call')
    return {
      message,
      toolCalls,
      stopReason: mapStop(incomplete, toolCalls.length > 0),
      usage: mapResponsesUsage(usage),
      model: this.model,
      latencyMs: Date.now() - started,
    }
  }

  private buildParams(req: ChatRequest): Params {
    const params: Params = {
      model: this.model,
      instructions: req.system,
      input: toInput(req.messages),
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: req.maxOutput,
      reasoning: { effort: (this.opts.reasoningEffortOverride ?? effortByReasoning[req.reasoning]) as OpenAI.Reasoning['effort'] },
    }
    if (req.tools.length > 0) {
      params.tools = req.tools.map(toTool)
      params.tool_choice = 'auto'
    }
    if (this.opts.temperature !== undefined) params.temperature = this.opts.temperature
    return Object.assign(params, this.opts.extraBody ?? {})
  }
}

/** Normaliza o uso da Responses API: entrada sem os tokens de cache, saida sem os de raciocinio. */
export function mapResponsesUsage(usage: ResponseUsage | null | undefined): Usage {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: true }
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0
  return {
    input: Math.max(0, usage.input_tokens - cacheRead - cacheWrite),
    output: Math.max(0, usage.output_tokens - reasoning),
    cacheRead,
    cacheWrite,
    reasoning,
    missing: false,
  }
}

/** Monta a mensagem do assistente a partir dos itens de saida, guardando todos eles para reenvio na proxima chamada. */
export function buildAssistant(output: OutputItem[]): Message {
  const parts: Part[] = []
  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content)
    .map((c) => (c.type === 'output_text' ? c.text : ''))
    .join('')
  if (text.length > 0) parts.push({ type: 'text', text })
  for (const item of output) {
    if (item.type !== 'function_call') continue
    parts.push({
      type: 'tool_call',
      id: item.call_id,
      name: item.name,
      args: parseArgs(item.arguments),
      rawArgs: item.arguments,
    })
  }
  const message: Message = { role: 'assistant', parts }
  if (output.length > 0) {
    message.raw = { output } satisfies ResponsesRaw
    message.rawProvider = 'openai-responses'
  }
  return message
}

/** Converte o historico em itens de entrada. Turnos do assistente voltam com os itens originais, preservando ordem e raciocinio cifrado. */
export function toInput(messages: Message[]): InputItem[] {
  const items: InputItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      items.push({ role: 'user', content: m.parts.map(partText).filter(Boolean).join('\n') })
      continue
    }
    if (m.role === 'assistant') {
      const raw = m.rawProvider === 'openai-responses' ? (m.raw as ResponsesRaw | undefined) : undefined
      if (raw?.output && raw.output.length > 0) {
        for (const item of raw.output) items.push(item as InputItem)
        continue
      }
      const text = m.parts.map(partText).join('')
      if (text.length > 0) items.push({ role: 'assistant', content: text })
      for (const p of m.parts) {
        if (p.type !== 'tool_call') continue
        items.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: p.rawArgs ?? JSON.stringify(p.args ?? {}) })
      }
      continue
    }
    for (const p of m.parts) {
      if (!isToolResult(p)) continue
      items.push({ type: 'function_call_output', call_id: p.callId, output: p.content })
    }
  }
  return items
}

function toTool(t: ToolDefinition): OpenAI.Responses.Tool {
  return { type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }
}

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function partText(p: Part): string {
  return p.type === 'text' ? p.text : ''
}

function isToolResult(p: Part): p is ToolResultPart {
  return p.type === 'tool_result'
}

function mapStop(incomplete: string | null, hasCalls: boolean): StopReason {
  if (hasCalls) return 'tool'
  if (incomplete === 'max_output_tokens') return 'max_output'
  if (incomplete === 'content_filter') return 'refusal'
  return 'end'
}
