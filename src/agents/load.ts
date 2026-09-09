import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Policy } from '../types.js'
import { RoutingFileSchema, RuleWhenSchema, emptyRouting, normalizeRouting, type Routing, type RuleWhen } from './routing.js'
import {
  BudgetsFileSchema,
  McpFileSchema,
  PolicySchema,
  ProfileFrontmatterSchema,
  SecretsFileSchema,
  type AgentProfile,
  type BudgetsFile,
  type McpFile,
} from './schema.js'

export interface LoadError {
  file: string
  message: string
}

export interface LoadedProfiles {
  profiles: Map<string, AgentProfile>
  errors: LoadError[]
}

export interface Skill {
  name: string
  description: string
  dir: string
  body: string
  activate?: RuleWhen
}

export interface AgentsRepo {
  profiles: Map<string, AgentProfile>
  policies: Map<string, Policy>
  skills: Map<string, Skill>
  budgets: BudgetsFile
  mcp: McpFile
  secrets: string[]
  routing: Routing
  errors: LoadError[]
}

/** Separa frontmatter YAML do corpo Markdown. */
export function splitFrontmatter(text: string): { data: unknown; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized }
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return { data: {}, body: normalized }
  const yamlText = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '')
  return { data: parseYaml(yamlText) ?? {}, body }
}

/** Le um perfil de agente a partir de um arquivo Markdown com frontmatter. */
export function parseProfile(file: string, text: string): AgentProfile {
  const { data, body } = splitFrontmatter(text)
  const front = ProfileFrontmatterSchema.parse(data)
  if (body.trim() === '') throw new Error('prompt de sistema vazio')
  return { ...front, system: body.trim(), file }
}

export function loadProfiles(dir: string): LoadedProfiles {
  const profiles = new Map<string, AgentProfile>()
  const errors: LoadError[] = []
  for (const file of listFiles(dir, '.md')) {
    try {
      const profile = parseProfile(file, readFileSync(file, 'utf8'))
      if (profiles.has(profile.name)) throw new Error(`nome duplicado: ${profile.name}`)
      profiles.set(profile.name, profile)
    } catch (err) {
      errors.push({ file, message: describe(err) })
    }
  }
  return { profiles, errors }
}

export function loadSkills(dir: string): { skills: Map<string, Skill>; errors: LoadError[] } {
  const skills = new Map<string, Skill>()
  const errors: LoadError[] = []
  if (!existsSync(dir)) return { skills, errors }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const { data, body } = splitFrontmatter(readFileSync(file, 'utf8'))
      const front = data as { name?: unknown; description?: unknown; activate?: unknown }
      const name = typeof front.name === 'string' ? front.name : entry.name
      const description = typeof front.description === 'string' ? front.description : ''
      const activate = front.activate === undefined ? undefined : RuleWhenSchema.parse(front.activate)
      skills.set(name, { name, description, dir: join(dir, entry.name), body: body.trim(), activate })
    } catch (err) {
      errors.push({ file, message: describe(err) })
    }
  }
  return { skills, errors }
}

/** Carrega o repositorio `agents` inteiro: perfis, politicas, skills, orcamentos e MCP. */
export function loadAgentsRepo(root: string): AgentsRepo {
  const errors: LoadError[] = []
  const loaded = loadProfiles(join(root, 'profiles'))
  errors.push(...loaded.errors)
  const skillsLoaded = loadSkills(join(root, 'skills'))
  errors.push(...skillsLoaded.errors)
  const policies = new Map<string, Policy>()
  for (const file of listFiles(join(root, 'policies'), '.json')) {
    const name = file.split(/[\\/]/).pop()!.replace(/\.json$/, '')
    if (name === 'budgets' || name === 'secrets') continue
    try {
      policies.set(name, PolicySchema.parse(readJson(file)))
    } catch (err) {
      errors.push({ file, message: describe(err) })
    }
  }
  const budgets = safeParse(join(root, 'policies', 'budgets.json'), BudgetsFileSchema, { agents: {} }, errors)
  const mcp = safeParse(join(root, 'mcp.json'), McpFileSchema, { servers: {} }, errors)
  const secrets = safeParse(join(root, 'policies', 'secrets.json'), SecretsFileSchema, { patterns: [] }, errors).patterns
  const routing = normalizeRouting(safeParse(join(root, 'routing.json'), RoutingFileSchema, emptyRouting, errors))
  return { profiles: loaded.profiles, policies, skills: skillsLoaded.skills, budgets, mcp, secrets, routing, errors }
}

function safeParse<T>(file: string, schema: { parse(v: unknown): T }, fallback: T, errors: LoadError[]): T {
  if (!existsSync(file)) return fallback
  try {
    return schema.parse(readJson(file))
  } catch (err) {
    errors.push({ file, message: describe(err) })
    return fallback
  }
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => join(dir, f))
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
