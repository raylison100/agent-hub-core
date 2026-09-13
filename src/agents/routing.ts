import { matchesGlob } from 'node:path'
import { z } from 'zod'
import { approxTokens } from '../context/estimate.js'
import type { Skill } from './load.js'
import { ScoringSchema, type Scoring } from './scoring.js'

export const RuleWhenSchema = z.object({
  workspace: z.string().optional(),
  intent: z.union([z.string(), z.array(z.string())]).optional(),
  files: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  prompt_tokens_lt: z.number().int().positive().optional(),
  prompt_tokens_gt: z.number().int().nonnegative().optional(),
})

export const RuleSchema = z.object({
  when: RuleWhenSchema,
  agent: z.string(),
})

export const ClassifierSchema = z.object({
  agent: z.string(),
  max_prompt_chars: z.number().int().positive().default(2000),
})

export const PromptImproverSchema = z.object({
  agent: z.string(),
  remote_agent: z.string().optional(),
  max_local_chars: z.number().int().positive().default(1200),
  min_chars: z.number().int().nonnegative().default(12),
  max_output: z.number().int().positive().default(1200),
  timeout_ms: z.number().int().positive().default(60000),
})

export const RoutingFileSchema = z.union([
  z.array(RuleSchema),
  z.object({
    intents: z.record(z.string(), z.array(z.string())).default({}),
    rules: z.array(RuleSchema).default([]),
    classifier: ClassifierSchema.optional(),
    default_agent: z.string().optional(),
    prompt_improver: PromptImproverSchema.optional(),
    scoring: ScoringSchema.optional(),
  }),
])

export type RuleWhen = z.infer<typeof RuleWhenSchema>
export type Rule = z.infer<typeof RuleSchema>
export type Classifier = z.infer<typeof ClassifierSchema>
export type PromptImprover = z.infer<typeof PromptImproverSchema>

export interface Routing {
  intents: Record<string, string[]>
  rules: Rule[]
  classifier?: Classifier
  default_agent?: string
  prompt_improver?: PromptImprover
  scoring?: Scoring
}

/** Prompt para o reescritor: melhora o pedido do usuario para o agente alvo sem inventar fatos. */
export function improverPrompt(original: string, targetAgent: string, targetDescription: string): string {
  return [
    `Reescreva o pedido abaixo como um prompt claro para o agente "${targetAgent}" (${targetDescription}).`,
    'Regras: mantenha a intencao e todos os fatos do original; nao invente requisitos, caminhos, nomes nem contexto de negocio;',
    'se o original nao disser onde ou por que sera usado, nao crie essa informacao. Deixe explicito o objetivo, o criterio de pronto',
    'e as restricoes que o original ja contem ou que sejam consequencia tecnica direta dele. Escreva em portugues, direto, sem saudacao.',
    'Se o pedido ja estiver claro, devolva-o quase igual. Responda apenas com o prompt reescrito.',
    '',
    'Pedido original:',
    original,
  ].join('\n')
}

export interface RouteContext {
  text: string
  workspace: string
}

export interface RouteResult {
  agent: string
  rule: Rule
  intent: string | null
}

export const emptyRouting: Routing = { intents: {}, rules: [] }

export function normalizeRouting(parsed: z.infer<typeof RoutingFileSchema>): Routing {
  return Array.isArray(parsed) ? { intents: {}, rules: parsed } : parsed
}

/** Prompt curto para um modelo barato escolher a intencao entre as declaradas, respondendo so o nome. */
export function classifierPrompt(intents: Record<string, string[]>, text: string, maxChars: number): string {
  const options = Object.entries(intents)
    .map(([name, keywords]) => `- ${name}: ${keywords.slice(0, 5).join(', ')}`)
    .join('\n')
  return [
    'Classifique o pedido abaixo em uma das intencoes. Responda apenas com o nome da intencao, ou "nenhuma".',
    '',
    'Intencoes:',
    options,
    '',
    'Pedido:',
    text.slice(0, maxChars),
  ].join('\n')
}

/** Formato de resposta do classificador: uma intencao declarada ou "nenhuma". */
export function classifierJsonSchema(intents: Record<string, string[]>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { intencao: { type: 'string', enum: [...Object.keys(intents), 'nenhuma'] } },
    required: ['intencao'],
    additionalProperties: false,
  }
}

/** Le a resposta do classificador, em JSON ou em palavra solta, e devolve uma intencao declarada ou null. */
export function parseClassifierAnswer(answer: string, intents: Record<string, string[]>): string | null {
  const json = /\{[\s\S]*\}/.exec(answer)
  if (json) {
    try {
      const valor = (JSON.parse(json[0]) as { intencao?: unknown }).intencao
      if (typeof valor === 'string') return valor in intents ? valor : null
    } catch {
      return null
    }
  }
  const word = answer.trim().toLowerCase().replace(/[^a-z0-9_-]+.*$/s, '')
  return word in intents ? word : null
}

/** Classifica a intencao por palavra chave, primeira intencao que casa vence. */
export function classifyIntent(text: string, intents: Record<string, string[]>): string | null {
  const lower = text.toLowerCase()
  for (const [intent, keywords] of Object.entries(intents)) {
    if (keywords.some((k) => wordMatch(lower, k.toLowerCase()))) return intent
  }
  return null
}

const delegationHints = [
  /sub-?agentes?/i,
  /\bdeleg(ar|ue|ue-se|a|ando|acao|ação)\b/i,
  /\b(varios|v[áa]rios|multiplos|m[úu]ltiplos|outro|outros|dois|tr[êe]s)\s+agentes?\b/i,
  /\bagentes?\s+em\s+paralelo\b/i,
  /\bspawn\b/i,
  /\bworktrees?\b/i,
  /\bdividir\s+(a\s+tarefa|o\s+trabalho)\b/i,
]

/** Pedido que fala em subagente, delegacao ou agentes trabalhando em paralelo: quem nao delega nao serve. */
export function needsDelegation(text: string): boolean {
  return delegationHints.some((r) => r.test(text))
}

/** Pedido curto vai ao improver local, de graca; pedido grande vai ao remoto, que aguenta texto longo sem perder qualidade nem demorar. */
export function improverAgent(cfg: PromptImprover, text: string): string {
  if (!cfg.remote_agent || text.trim().length <= cfg.max_local_chars) return cfg.agent
  return cfg.remote_agent
}

/** Primeira regra que casa decide o agente. Sem regra casando, devolve null. `intentOverride` vem do classificador por modelo. */
export function route(routing: Routing, ctx: RouteContext, intentOverride?: string | null): RouteResult | null {
  const intent = intentOverride === undefined ? classifyIntent(ctx.text, routing.intents) : intentOverride
  const tokens = approxTokens(ctx.text)
  const files = pathsIn(ctx.text)
  for (const rule of routing.rules) {
    if (matches(rule.when, ctx, intent, tokens, files)) return { agent: rule.agent, rule, intent }
  }
  return null
}

/** Skills cujo `activate` casa com o contexto, restritas as que o perfil lista. */
export function activatedSkills(skills: Map<string, Skill>, allowed: string[], ctx: RouteContext, intents: Record<string, string[]>): Skill[] {
  const intent = classifyIntent(ctx.text, intents)
  const files = pathsIn(ctx.text)
  return allowed
    .map((n) => skills.get(n))
    .filter((s): s is Skill => s !== undefined && s.activate !== undefined)
    .filter((s) => matches(s.activate!, ctx, intent, approxTokens(ctx.text), files))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function matches(when: RuleWhen, ctx: RouteContext, intent: string | null, tokens: number, files: string[]): boolean {
  if (when.workspace && !matchesGlob(ctx.workspace.replace(/\\/g, '/'), when.workspace)) return false
  if (when.intent !== undefined) {
    const wanted = Array.isArray(when.intent) ? when.intent : [when.intent]
    if (intent === null || !wanted.includes(intent)) return false
  }
  if (when.files && !when.files.some((g) => files.some((f) => matchesGlob(f, g) || matchesGlob(basename(f), g)))) return false
  if (when.keywords && !when.keywords.some((k) => wordMatch(ctx.text.toLowerCase(), k.toLowerCase()))) return false
  if (when.prompt_tokens_lt !== undefined && !(tokens < when.prompt_tokens_lt)) return false
  if (when.prompt_tokens_gt !== undefined && !(tokens > when.prompt_tokens_gt)) return false
  return true
}

function wordMatch(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(text)
}

function pathsIn(text: string): string[] {
  return (text.match(/[\w./\\-]+\.[a-z0-9]{1,8}\b/gi) ?? []).map((p) => p.replace(/\\/g, '/'))
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

/** Regra de ativacao avaliada so com o texto e o workspace, para memoria do projeto e outros blocos sem intencao. */
export function matchesWhen(when: RuleWhen, ctx: RouteContext, intent: string | null = null): boolean {
  return matches(when, ctx, intent, approxTokens(ctx.text), pathsIn(ctx.text))
}
