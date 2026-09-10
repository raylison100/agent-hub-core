import type { AgentProfile } from '../agents/schema.js'
import type { ProviderAdapter } from '../types.js'
import { AnthropicAdapter } from './anthropic.js'
import { OpenAICompatibleAdapter } from './openai-compatible.js'

export { AnthropicAdapter, mapAnthropicUsage } from './anthropic.js'
export { OpenAICompatibleAdapter, mapOpenAICompatibleUsage } from './openai-compatible.js'

const defaultBaseUrl: Record<string, string | undefined> = {
  deepseek: 'https://api.deepseek.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  ollama: 'http://127.0.0.1:11434/v1',
  openai: undefined,
  anthropic: undefined,
}

const defaultKeyEnv: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: 'OLLAMA_API_KEY',
}

export class MissingApiKeyError extends Error {
  constructor(readonly envName: string, readonly provider: string) {
    super(`Variavel ${envName} nao definida para o provedor ${provider}`)
  }
}

/** Resolve o modelo efetivo do perfil. Mantem a troca legada deepseek-chat para deepseek-reasoner; no V4 o raciocinio e por parametro. */
export function resolveModel(profile: Pick<AgentProfile, 'provider' | 'model' | 'reasoning'>): string {
  const deep = profile.provider === 'deepseek' && profile.model === 'deepseek-chat'
  const high = profile.reasoning === 'high' || profile.reasoning === 'max'
  return deep && high ? 'deepseek-reasoner' : profile.model
}

/** Cria o adaptador de provedor para um perfil, lendo a chave do ambiente. */
export function createAdapter(profile: AgentProfile, env: NodeJS.ProcessEnv = process.env): ProviderAdapter {
  const opts = profile.provider_options
  const keyEnv = stringOpt(opts, 'api_key_env', env) ?? defaultKeyEnv[profile.provider] ?? ''
  const apiKey = env[keyEnv]
  const baseURL = stringOpt(opts, 'base_url', env) ?? defaultBaseUrl[profile.provider]
  const model = resolveModel(profile)

  if (profile.provider === 'anthropic') {
    if (!apiKey) throw new MissingApiKeyError(keyEnv, profile.provider)
    return new AnthropicAdapter({ model, apiKey, baseURL, sendEffort: boolOpt(opts, 'effort') ?? true })
  }
  if (profile.provider === 'ollama') {
    return new OpenAICompatibleAdapter({
      provider: 'ollama',
      model,
      apiKey: apiKey ?? 'ollama',
      baseURL,
      sendReasoningEffort: false,
      temperature: numberOpt(opts, 'temperature'),
      seed: numberOpt(opts, 'seed'),
    })
  }
  if (!apiKey) throw new MissingApiKeyError(keyEnv, profile.provider)
  return new OpenAICompatibleAdapter({
    provider: profile.provider,
    model,
    apiKey,
    baseURL,
    sendReasoningEffort: profile.provider === 'openai' || profile.provider === 'gemini',
    effortCap: profile.provider === 'gemini' ? 'high' : undefined,
    reasoningEffortOverride: stringOpt(opts, 'reasoning_effort'),
    deepseekThinking: profile.provider === 'deepseek' && model.startsWith('deepseek-v4'),
    temperature: numberOpt(opts, 'temperature'),
    seed: numberOpt(opts, 'seed'),
  })
}

/** Le uma opcao de texto expandindo `${VAR}` e `$VAR` do ambiente, para hosts que mudam, como o gateway do WSL. */
function stringOpt(opts: Record<string, unknown>, key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = opts[key]
  if (typeof v !== 'string') return undefined
  return v.replace(/\$\{?([A-Z0-9_]+)\}?/g, (match, name: string) => env[name] ?? match)
}

function numberOpt(opts: Record<string, unknown>, key: string): number | undefined {
  const v = opts[key]
  return typeof v === 'number' ? v : undefined
}

function boolOpt(opts: Record<string, unknown>, key: string): boolean | undefined {
  const v = opts[key]
  return typeof v === 'boolean' ? v : undefined
}
