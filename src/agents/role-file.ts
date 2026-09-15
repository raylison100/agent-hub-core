import { stringify } from 'yaml'
import type { RoleDetail } from '../protocol/frames.js'
import { parseRole } from './load.js'
import type { AgentRole } from './schema.js'

/** Monta o Markdown com frontmatter de um papel e confere que ele volta igual pelo parser. */
export function serializeRole(role: RoleDetail): string {
  const front: Record<string, unknown> = {
    name: role.name,
    description: role.description,
    models: role.models,
  }
  if (role.tools.native.length || role.tools.mcp.length) front.tools = { native: role.tools.native, mcp: role.tools.mcp }
  if (role.skills.length) front.skills = role.skills
  if (role.policy) front.policy = role.policy
  if (role.max_steps) front.max_steps = role.max_steps
  const budget: Record<string, number> = {}
  if (role.budget.run_usd !== undefined) budget.run_usd = role.budget.run_usd
  if (role.budget.session_usd !== undefined) budget.session_usd = role.budget.session_usd
  if (Object.keys(budget).length) front.budget = budget
  const text = `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n\n${role.prompt.trim()}\n`
  parseRole(`${role.name}.md`, text)
  return text
}

/** Detalhe editavel de um papel carregado. */
export function roleDetail(role: AgentRole): RoleDetail {
  return {
    name: role.name,
    description: role.description,
    models: role.models,
    tools: { native: role.tools?.native ?? [], mcp: role.tools?.mcp ?? [] },
    skills: role.skills ?? [],
    policy: role.policy ?? null,
    max_steps: role.max_steps ?? null,
    budget: { run_usd: role.budget?.run_usd, session_usd: role.budget?.session_usd },
    prompt: role.system,
  }
}
