import { matchesGlob } from 'node:path'
import { z } from 'zod'
import { approxTokens } from '../context/estimate.js'
import type { Skill } from './load.js'

export const RuleWhenSchema = z.object({
  workspace: z.string().optional(),
  intent: z.union([z.string(), z.array(z.string())]).optional(),
  files: z.array(z.string()).optional(),
  prompt_tokens_lt: z.number().int().positive().optional(),
  prompt_tokens_gt: z.number().int().nonnegative().optional(),
})

export const RuleSchema = z.object({
  when: RuleWhenSchema,
  agent: z.string(),
})

export const RoutingFileSchema = z.union([
  z.array(RuleSchema),
  z.object({
    intents: z.record(z.string(), z.array(z.string())).default({}),
    rules: z.array(RuleSchema).default([]),
  }),
])

export type RuleWhen = z.infer<typeof RuleWhenSchema>
export type Rule = z.infer<typeof RuleSchema>

export interface Routing {
  intents: Record<string, string[]>
  rules: Rule[]
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

/** Classifica a intencao por palavra chave, primeira intencao que casa vence. */
export function classifyIntent(text: string, intents: Record<string, string[]>): string | null {
  const lower = text.toLowerCase()
  for (const [intent, keywords] of Object.entries(intents)) {
    if (keywords.some((k) => wordMatch(lower, k.toLowerCase()))) return intent
  }
  return null
}

/** Primeira regra que casa decide o agente. Sem regra casando, devolve null. */
export function route(routing: Routing, ctx: RouteContext): RouteResult | null {
  const intent = classifyIntent(ctx.text, routing.intents)
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
