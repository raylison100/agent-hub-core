export type Risk = 'read' | 'write' | 'exec'
export type Reasoning = 'low' | 'medium' | 'high' | 'max'
export type ProviderId = 'anthropic' | 'deepseek' | 'openai' | 'gemini' | 'ollama'
export type Decision = 'allow' | 'ask' | 'deny'

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  missing: boolean
}

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolCallPart {
  type: 'tool_call'
  id: string
  name: string
  args: unknown
  rawArgs?: string
  extra?: Record<string, unknown>
}

export interface ToolResultPart {
  type: 'tool_result'
  callId: string
  content: string
  isError: boolean
}

export type Part = TextPart | ToolCallPart | ToolResultPart

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  parts: Part[]
  raw?: unknown
  rawProvider?: string
  kind?: 'compaction'
  runId?: string
}

export type JsonSchema = Record<string, unknown>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
  risk: Risk
}

export interface ChatRequest {
  system: string
  messages: Message[]
  tools: ToolDefinition[]
  maxOutput: number
  reasoning: Reasoning
  systemCacheTtl: '5m' | '1h'
  providerOptions: Record<string, unknown>
  signal?: AbortSignal
}

export interface ChatEvents {
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
}

export type StopReason = 'end' | 'tool' | 'max_output' | 'refusal' | 'error'

export interface ChatResult {
  message: Message
  toolCalls: ToolCallPart[]
  stopReason: StopReason
  usage: Usage
  model: string
  latencyMs: number
}

export interface Capabilities {
  streaming: boolean
  cacheControl: boolean
  countTokens: boolean
  reasoningLevels: boolean
  historyEditable: boolean
}

export interface ProviderAdapter {
  readonly provider: ProviderId
  readonly model: string
  chat(req: ChatRequest, on?: ChatEvents): Promise<ChatResult>
  countTokens?(req: ChatRequest): Promise<number>
  capabilities(): Capabilities
}

export interface Policy {
  read: Decision
  write: Decision
  exec: Decision
}

/** Cria um Usage zerado. */
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false }
}

/** Extrai o texto concatenado das partes de texto de uma mensagem. */
export function messageText(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
