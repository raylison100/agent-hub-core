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

export const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  risk: z.record(z.string(), z.enum(['read', 'write', 'exec'])).default({ '*': 'write' }),
})

export const McpFileSchema = z.object({
  servers: z.record(z.string(), McpServerSchema).default({}),
})

export type McpServerConfig = z.infer<typeof McpServerSchema>
export type McpFile = z.infer<typeof McpFileSchema>
