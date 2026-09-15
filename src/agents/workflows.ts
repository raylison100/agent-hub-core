import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { LoadError } from './load.js'
import type { AgentProfile } from './schema.js'

const RetrySchema = z.object({
  step: z.string(),
  max: z.number().int().positive().default(1),
  when: z.string().min(1),
})

const ToolStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  retry: RetrySchema.optional(),
})

const AgentStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  agent: z.string(),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  max_steps: z.number().int().positive().optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  retry: RetrySchema.optional(),
})

const GateStepSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  gate: z.string().min(1),
  question: z.string().optional(),
  on_fail: z.enum(['ask', 'stop']).default('ask'),
})

export const WorkflowStepSchema = z.union([ToolStepSchema, AgentStepSchema, GateStepSchema])

export const WorkflowSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().default(''),
  inputs: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
  budget_usd: z.number().nonnegative().optional(),
  mode: z.enum(['draft', 'normal']).default('normal'),
  steps: z.array(WorkflowStepSchema).min(1),
})

export type WorkflowRetry = z.infer<typeof RetrySchema>
export type ToolStep = z.infer<typeof ToolStepSchema>
export type AgentStep = z.infer<typeof AgentStepSchema>
export type GateStep = z.infer<typeof GateStepSchema>
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>
export type Workflow = z.infer<typeof WorkflowSchema>

export interface WorkflowSummary {
  name: string
  description: string
  inputs: string[]
  mode: 'draft' | 'normal'
  maxCostUsd: number | null
  budgetUsd: number | null
  steps: { id: string; kind: 'tool' | 'agent' | 'gate'; target: string }[]
}

export type StepResult = Record<string, unknown> & { output: string; exit_code?: number; cost_usd?: number }

export function isToolStep(step: WorkflowStep): step is ToolStep {
  return 'tool' in step
}

export function isGateStep(step: WorkflowStep): step is GateStep {
  return 'gate' in step
}

export function isAgentStep(step: WorkflowStep): step is AgentStep {
  return 'agent' in step
}

/** Le `agents/workflows/*.yaml` validando cada arquivo. */
export function loadWorkflows(dir: string): { workflows: Map<string, Workflow>; errors: LoadError[] } {
  const workflows = new Map<string, Workflow>()
  const errors: LoadError[] = []
  if (!existsSync(dir)) return { workflows, errors }
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const path = join(dir, file)
    try {
      const wf = WorkflowSchema.parse(parseYaml(readFileSync(path, 'utf8')))
      validateReferences(wf)
      workflows.set(wf.name, wf)
    } catch (err) {
      errors.push({ file: path, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { workflows, errors }
}

/** Repeticao possivel de cada etapa, contando os retry que voltam para tras. */
function repetitions(wf: Workflow): Map<string, number> {
  const multiplier = new Map<string, number>()
  for (const step of wf.steps) multiplier.set(step.id, 1)
  for (const step of wf.steps) {
    const retry = isGateStep(step) ? undefined : step.retry
    if (!retry) continue
    const from = wf.steps.findIndex((s) => s.id === retry.step)
    const to = wf.steps.findIndex((s) => s.id === step.id)
    for (let i = from; i <= to; i++) {
      const id = wf.steps[i]!.id
      multiplier.set(id, (multiplier.get(id) ?? 1) + retry.max)
    }
  }
  return multiplier
}

/** Custo maximo antes de rodar: soma do orcamento por run de cada etapa de agente, vezes as repeticoes possiveis. */
export function maxWorkflowCost(wf: Workflow, profiles: Map<string, AgentProfile>): number | null {
  const multiplier = repetitions(wf)
  let total = 0
  for (const step of wf.steps) {
    if (!isAgentStep(step)) continue
    const profile = profiles.get(step.agent)
    if (!profile || profile.budget.run_usd === undefined) return null
    total += profile.budget.run_usd * (multiplier.get(step.id) ?? 1)
  }
  return total
}

export function summarizeWorkflow(wf: Workflow, profiles: Map<string, AgentProfile>): WorkflowSummary {
  return {
    name: wf.name,
    description: wf.description,
    inputs: wf.inputs,
    mode: wf.mode,
    maxCostUsd: maxWorkflowCost(wf, profiles),
    budgetUsd: wf.budget_usd ?? null,
    steps: wf.steps.map((s) => (isToolStep(s) ? { id: s.id, kind: 'tool' as const, target: s.tool } : isGateStep(s) ? { id: s.id, kind: 'gate' as const, target: s.gate } : { id: s.id, kind: 'agent' as const, target: s.agent })),
  }
}

/** Substitui `{{caminho}}` por valores do contexto: entradas e resultados de etapas anteriores. */
export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => stringify(valueAt(context, path)))
}

export function renderArgs(args: Record<string, unknown>, context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' ? renderTemplate(v, context) : v
  return out
}

/** Condicao de retry: `campo op valor`, com op em ==, !=, >, <, >=, <=, contains, matches. */
export function evaluateCondition(expr: string, result: StepResult): boolean {
  const m = /^\s*([\w.]+)\s*(==|!=|>=|<=|>|<|contains|matches)\s*(.+?)\s*$/.exec(expr)
  if (!m) throw new Error(`condição inválida: ${expr}`)
  const left = valueAt(result, m[1]!)
  const rawRight = m[3]!
  const right = /^-?\d+(\.\d+)?$/.test(rawRight) ? Number(rawRight) : rawRight.replace(/^['"]|['"]$/g, '')
  switch (m[2]) {
    case '==':
      return String(left) === String(right)
    case '!=':
      return String(left) !== String(right)
    case '>':
      return Number(left) > Number(right)
    case '<':
      return Number(left) < Number(right)
    case '>=':
      return Number(left) >= Number(right)
    case '<=':
      return Number(left) <= Number(right)
    case 'contains':
      return String(left ?? '').includes(String(right))
    case 'matches':
      return new RegExp(String(right)).test(String(left ?? ''))
    default:
      return false
  }
}

/** Extrai `exit_code` da primeira linha da saida de run_command. */
export function parseExitCode(output: string): number | undefined {
  const m = /^exit_code (\d+)/.exec(output)
  return m ? Number(m[1]) : undefined
}

function validateReferences(wf: Workflow): void {
  const ids = new Set<string>()
  for (const step of wf.steps) {
    if (ids.has(step.id)) throw new Error(`etapa duplicada: ${step.id}`)
    ids.add(step.id)
  }
  for (const step of wf.steps) {
    const retry = isGateStep(step) ? undefined : step.retry
    if (!retry) continue
    const from = wf.steps.findIndex((s) => s.id === retry.step)
    const to = wf.steps.findIndex((s) => s.id === step.id)
    if (from === -1) throw new Error(`retry de ${step.id} aponta para etapa inexistente: ${retry.step}`)
    if (from > to) throw new Error(`retry de ${step.id} precisa apontar para uma etapa anterior ou a própria`)
  }
}

function valueAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}
