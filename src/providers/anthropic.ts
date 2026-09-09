import Anthropic from '@anthropic-ai/sdk'
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

type StreamParams = Parameters<Anthropic['messages']['stream']>[0]
type Effort = 'low' | 'medium' | 'high' | 'xhigh'

const effortByReasoning: Record<Reasoning, Effort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
}

export interface AnthropicAdapterOptions {
  model: string
  apiKey?: string
  baseURL?: string
  sendEffort?: boolean
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const
  readonly model: string
  private readonly client: Anthropic
  private readonly sendEffort: boolean

  constructor(opts: AnthropicAdapterOptions) {
    this.model = opts.model
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL })
    this.sendEffort = opts.sendEffort ?? true
  }

  capabilities(): Capabilities {
    return { streaming: true, cacheControl: true, countTokens: true, reasoningLevels: true }
  }

  async countTokens(req: ChatRequest): Promise<number> {
    const res = await this.client.messages.countTokens({
      model: this.model,
      system: toSystem(req),
      tools: toTools(req.tools),
      messages: toMessages(req.messages),
    })
    return res.input_tokens
  }

  async chat(req: ChatRequest, on: ChatEvents = {}): Promise<ChatResult> {
    const started = Date.now()
    const stream = this.client.messages.stream(this.buildParams(req), { signal: req.signal })
    stream.on('text', (delta) => on.onText?.(delta))
    stream.on('thinking', (delta) => on.onReasoning?.(delta))
    const message = await stream.finalMessage()
    const assistant = fromAssistant(message)
    return {
      message: assistant,
      toolCalls: assistant.parts.filter((p): p is ToolCallPart => p.type === 'tool_call'),
      stopReason: mapStop(message.stop_reason),
      usage: mapAnthropicUsage(message.usage),
      model: message.model,
      latencyMs: Date.now() - started,
    }
  }

  private buildParams(req: ChatRequest): StreamParams {
    const params: StreamParams = {
      model: this.model,
      max_tokens: req.maxOutput,
      system: toSystem(req),
      tools: toTools(req.tools),
      messages: toMessages(req.messages),
    }
    if (this.sendEffort) params.output_config = { effort: effortByReasoning[req.reasoning] }
    return params
  }
}

/** Normaliza o campo usage da Anthropic para o formato interno. */
export function mapAnthropicUsage(usage: Anthropic.Usage | null | undefined): Usage {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: true }
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    reasoning: 0,
    missing: false,
  }
}

function toSystem(req: ChatRequest): Anthropic.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: req.system,
      cache_control: { type: 'ephemeral', ttl: req.systemCacheTtl },
    },
  ]
}

function toTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t, i) => {
    const tool: Anthropic.Tool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }
    if (i === tools.length - 1) tool.cache_control = { type: 'ephemeral' }
    return tool
  })
}

function toMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map(toMessageParam)
}

function toMessageParam(m: Message): Anthropic.MessageParam {
  if (m.role === 'assistant' && m.rawProvider === 'anthropic' && Array.isArray(m.raw)) {
    return { role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] }
  }
  if (m.role === 'assistant') {
    return { role: 'assistant', content: m.parts.map(toAssistantBlock).filter(isBlock) }
  }
  if (m.role === 'tool') {
    return { role: 'user', content: m.parts.filter(isToolResult).map(toToolResultBlock) }
  }
  return { role: 'user', content: m.parts.map(toUserBlock).filter(isBlock) }
}

function toAssistantBlock(p: Part): Anthropic.ContentBlockParam | null {
  if (p.type === 'text') return { type: 'text', text: p.text }
  if (p.type === 'tool_call') return { type: 'tool_use', id: p.id, name: p.name, input: p.args ?? {} }
  return null
}

function toUserBlock(p: Part): Anthropic.ContentBlockParam | null {
  if (p.type === 'text') return { type: 'text', text: p.text }
  if (p.type === 'tool_result') return toToolResultBlock(p)
  return null
}

function toToolResultBlock(p: ToolResultPart): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: p.callId, content: p.content, is_error: p.isError }
}

function isToolResult(p: Part): p is ToolResultPart {
  return p.type === 'tool_result'
}

function isBlock(b: Anthropic.ContentBlockParam | null): b is Anthropic.ContentBlockParam {
  return b !== null
}

function fromAssistant(message: Anthropic.Message): Message {
  const parts: Part[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    if (block.type === 'tool_use') parts.push({ type: 'tool_call', id: block.id, name: block.name, args: block.input })
  }
  return { role: 'assistant', parts, raw: message.content, rawProvider: 'anthropic' }
}

function mapStop(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool'
    case 'max_tokens':
      return 'max_output'
    case 'refusal':
      return 'refusal'
    default:
      return 'end'
  }
}
