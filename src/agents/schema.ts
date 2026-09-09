import { z } from 'zod'

export const ProfileFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  provider: z.enum(['anthropic', 'deepseek', 'openai', 'ollama']),
  model: z.string().min(1),
  reasoning: z.enum(['low', 'medium', 'high', 'max']).default('medium'),
  max_output: z.number().int().positive().default(8000),
  max_steps: z.number().int().positive().default(30),
  tools: z
    .object({
      native: z.array(z.string()).default([]),
      mcp: z.array(z.string()).default([]),
    })
    .default({ native: [], mcp: [] }),
  skills: z.array(z.string()).default([]),
  policy: z.string().default('padrao'),
  budget: z
    .object({
      run_usd: z.number().nonnegative().optional(),
      session_usd: z.number().nonnegative().optional(),
    })
    .default({}),
  context: z.object({
    window: z.number().int().positive(),
    compact_at: z.number().min(0.1).max(1).default(0.7),
    summarizer: z.string().optional(),
  }),
  delegates: z.array(z.string()).default([]),
  fallback_agent: z.string().optional(),
  repair_attempts: z.number().int().min(0).default(2),
  cache: z
    .object({
      system_ttl: z.enum(['5m', '1h']).default('5m'),
    })
    .default({ system_ttl: '5m' }),
  provider_options: z.record(z.string(), z.unknown()).default({}),
})

export type ProfileFrontmatter = z.infer<typeof ProfileFrontmatterSchema>

export interface AgentProfile extends ProfileFrontmatter {
  system: string
  file: string
}

export const PolicySchema = z.object({
  read: z.enum(['allow', 'ask', 'deny']),
  write: z.enum(['allow', 'ask', 'deny']),
  exec: z.enum(['allow', 'ask', 'deny']),
})

export const BudgetsFileSchema = z.object({
  global_month_usd: z.number().nonnegative().optional(),
  automation_month_usd: z.number().nonnegative().optional(),
  agents: z.record(z.string(), z.object({ day_usd: z.number().nonnegative().optional() })).default({}),
})

export type BudgetsFile = z.infer<typeof BudgetsFileSchema>

export const McpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    risk: z.record(z.string(), z.enum(['read', 'write', 'exec'])).default({ '*': 'write' }),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.url), { message: 'informe command (stdio) ou url (http), nunca ambos' })

export const SecretsFileSchema = z.object({
  patterns: z.array(z.string()).default([]),
})

export const ScheduleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    cron: z.string().optional(),
    at: z.number().int().positive().optional(),
    timezone: z.string().default('UTC'),
    agent: z.string(),
    workspace: z.string(),
    prompt: z.string().min(1),
    mode: z.enum(['draft', 'normal']).default('draft'),
    budget: z.object({ run_usd: z.number().nonnegative(), day_usd: z.number().nonnegative() }),
    overlap: z.enum(['queue', 'skip']).default('skip'),
    missed: z.enum(['skip', 'run_once']).default('skip'),
    enabled: z.boolean().default(true),
  })
  .refine((s) => Boolean(s.cron) !== Boolean(s.at), { message: 'informe cron ou at, nunca ambos' })

export type ScheduleInput = z.input<typeof ScheduleSchema>
export type ScheduleParsed = z.infer<typeof ScheduleSchema>

export const TriggerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  source: z.enum(['gitlab', 'github', 'generic']),
  secret_ref: z.string().regex(/^\$[A-Z0-9_]+$/, 'secret_ref deve ser o nome de uma variavel de ambiente com $'),
  filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  agent: z.string(),
  workspace: z.string(),
  prompt: z.string().min(1),
  mode: z.enum(['draft', 'normal']).default('draft'),
  budget: z.object({ run_usd: z.number().nonnegative(), day_usd: z.number().nonnegative() }),
  dedupe: z.string().optional(),
  overlap: z.enum(['queue', 'skip']).default('queue'),
  enabled: z.boolean().default(true),
})

export type TriggerParsed = z.infer<typeof TriggerSchema>

export const WebhookSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  secret_ref: z.string().regex(/^\$[A-Z0-9_]+$/),
  events: z.array(z.string()).min(1),
})

export const WebhooksFileSchema = z.object({
  hooks: z.array(WebhookSchema).default([]),
})

export type WebhookConfig = z.infer<typeof WebhookSchema>

export const McpFileSchema = z.object({
  servers: z.record(z.string(), McpServerSchema).default({}),
})

export type McpServerConfig = z.infer<typeof McpServerSchema>
export type McpFile = z.infer<typeof McpFileSchema>
