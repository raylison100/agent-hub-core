import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { HookConfigSchema, type HookConfig } from '../hooks/runner.js'
import { splitFrontmatter, loadSkills, type LoadError, type Skill } from './load.js'
import { McpServerSchema, ProfileFrontmatterSchema, type AgentProfile, type McpServerConfig } from './schema.js'

export const PluginEntrySchema = z
  .object({
    path: z.string().optional(),
    git: z.string().url().optional(),
    ref: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .refine((e) => Boolean(e.path) !== Boolean(e.git), { message: 'informe path ou git, nunca ambos' })

export const PluginsFileSchema = z.object({
  plugins: z.array(PluginEntrySchema).default([]),
})

export type PluginEntry = z.infer<typeof PluginEntrySchema>

export const gitPluginsDir = '.plugins'

/** Diretorio local de um plugin vindo de git, dentro do repositorio agents. */
export function gitPluginDir(base: string, gitUrl: string): string {
  const name = slug(gitUrl.replace(/\.git$/, '').split('/').slice(-2).join('-'))
  return join(base, gitPluginsDir, name)
}

export const ProfileOverrideSchema = z.object({
  provider: z.enum(['anthropic', 'deepseek', 'openai', 'gemini', 'ollama']),
  model: z.string(),
  reasoning: z.enum(['low', 'medium', 'high', 'max']).optional(),
  context: z.object({ window: z.number().int().positive(), compact_at: z.number().optional(), summarizer: z.string().optional() }),
  budget: z.object({ run_usd: z.number().optional(), session_usd: z.number().optional() }).optional(),
  policy: z.string().optional(),
  provider_options: z.record(z.string(), z.unknown()).optional(),
})

export const OverridesFileSchema = z.record(z.string(), ProfileOverrideSchema)

export type ProfileOverride = z.infer<typeof ProfileOverrideSchema>

export interface PluginBundle {
  name: string
  dir: string
  skills: Map<string, Skill>
  profiles: Map<string, AgentProfile>
  mcp: Record<string, McpServerConfig>
  hooks: HookConfig[]
  errors: LoadError[]
}

const claudeToolMap: Record<string, string> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Bash: 'run_command',
  Grep: 'search',
  Glob: 'list_dir',
  LS: 'list_dir',
}

const claudeEventMap: Record<string, HookConfig['event']> = {
  PreToolUse: 'tool.before',
  PostToolUse: 'tool.after',
  Stop: 'run.end',
  UserPromptSubmit: 'run.start',
}

/** Le um plugin no layout do Claude Code e devolve skills, perfis, servidores MCP e hooks com prefixo do plugin. */
export function loadPlugin(dir: string, overrides: Record<string, ProfileOverride>): PluginBundle {
  const errors: LoadError[] = []
  const name = pluginName(dir, errors)
  const skills = new Map<string, Skill>()
  for (const [key, skill] of loadSkills(join(dir, 'skills')).skills) skills.set(`${name}:${key}`, { ...skill, name: `${name}:${key}`, root: dir })
  for (const cmd of loadCommands(dir, name, errors)) skills.set(cmd.name, { ...cmd, root: dir })
  const profiles = loadPluginProfiles(dir, name, [...skills.keys()], overrides, errors)
  const mcp = loadPluginMcp(dir, name, errors)
  const hooks = loadPluginHooks(dir, errors)
  return { name, dir, skills, profiles, mcp, hooks, errors }
}

export function loadPlugins(entries: PluginEntry[], overrides: Record<string, ProfileOverride>, base: string): PluginBundle[] {
  return entries
    .filter((e) => e.enabled)
    .map((e) => {
      const dir = e.git ? gitPluginDir(base, e.git) : resolve(base, e.path!)
      if (!existsSync(dir)) {
        const message = e.git ? `plugin git ainda nao clonado; rode agent-hub-daemon plugins sync` : 'plugin nao encontrado'
        return { name: basename(dir), dir, skills: new Map(), profiles: new Map(), mcp: {}, hooks: [], errors: [{ file: dir, message }] }
      }
      return loadPlugin(dir, overrides)
    })
}

function pluginName(dir: string, errors: LoadError[]): string {
  const manifest = join(dir, '.claude-plugin', 'plugin.json')
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (typeof parsed.name === 'string' && parsed.name) return slug(parsed.name)
    } catch (err) {
      errors.push({ file: manifest, message: describe(err) })
    }
  }
  return slug(basename(dir))
}

function loadCommands(dir: string, plugin: string, errors: LoadError[]): Skill[] {
  const commandsDir = join(dir, 'commands')
  if (!existsSync(commandsDir)) return []
  const out: Skill[] = []
  for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const { data, body } = splitFrontmatter(readFileSync(join(commandsDir, file), 'utf8'))
      const front = data as { description?: unknown }
      const key = file.replace(/\.md$/, '')
      const description = typeof front.description === 'string' ? front.description : body.split('\n')[0]?.slice(0, 120) ?? ''
      out.push({ name: `${plugin}:${key}`, description, dir: commandsDir, body: body.trim() })
    } catch (err) {
      errors.push({ file: join(commandsDir, file), message: describe(err) })
    }
  }
  return out
}

function loadPluginProfiles(
  dir: string,
  plugin: string,
  skillNames: string[],
  overrides: Record<string, ProfileOverride>,
  errors: LoadError[],
): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>()
  const agentsDir = join(dir, 'agents')
  if (!existsSync(agentsDir)) return profiles
  for (const file of readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort()) {
    const path = join(agentsDir, file)
    try {
      const { data, body } = splitFrontmatter(readFileSync(path, 'utf8'))
      const front = data as { name?: unknown; description?: unknown; tools?: unknown }
      const localName = slug(typeof front.name === 'string' ? front.name : file.replace(/\.md$/, ''))
      const fullName = `${plugin}-${localName}`
      const override = overrides[`${plugin}/${localName}`] ?? overrides[plugin] ?? overrides.default
      if (!override) throw new Error(`sem override de provedor e modelo para ${fullName}; defina em overrides.json`)
      const native = mapTools(front.tools)
      const profile = ProfileFrontmatterSchema.parse({
        name: fullName,
        description: typeof front.description === 'string' ? front.description : `agente do plugin ${plugin}`,
        provider: override.provider,
        model: override.model,
        reasoning: override.reasoning,
        tools: { native, mcp: [] },
        skills: skillNames,
        policy: override.policy,
        budget: override.budget ?? {},
        context: override.context,
        provider_options: override.provider_options ?? {},
      })
      if (body.trim() === '') throw new Error('prompt de sistema vazio')
      profiles.set(fullName, { ...profile, system: body.trim(), file: path })
    } catch (err) {
      errors.push({ file: path, message: describe(err) })
    }
  }
  return profiles
}

function loadPluginMcp(dir: string, plugin: string, errors: LoadError[]): Record<string, McpServerConfig> {
  const file = join(dir, '.mcp.json')
  if (!existsSync(file)) return {}
  const out: Record<string, McpServerConfig> = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }
    for (const [server, raw] of Object.entries(parsed.mcpServers ?? {})) {
      const config = McpServerSchema.parse({
        command: typeof raw.command === 'string' ? expandRoot(raw.command, dir) : undefined,
        args: Array.isArray(raw.args) ? raw.args.map((a) => expandRoot(String(a), dir)) : [],
        env: isRecord(raw.env) ? mapValues(raw.env, (v) => expandRoot(String(v), dir)) : {},
        url: typeof raw.url === 'string' ? raw.url : undefined,
        headers: isRecord(raw.headers) ? mapValues(raw.headers, String) : {},
        risk: isRecord(raw.risk) ? raw.risk : { '*': 'write' },
      })
      out[`${plugin}-${slug(server)}`] = config
    }
  } catch (err) {
    errors.push({ file, message: describe(err) })
  }
  return out
}

function loadPluginHooks(dir: string, errors: LoadError[]): HookConfig[] {
  const file = join(dir, 'hooks', 'hooks.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[]> }
    const out: HookConfig[] = []
    for (const [eventName, groups] of Object.entries(parsed.hooks ?? {})) {
      const event = claudeEventMap[eventName]
      if (!event) {
        errors.push({ file, message: `evento ${eventName} sem equivalente; ignorado` })
        continue
      }
      for (const group of groups) {
        for (const h of group.hooks ?? []) {
          if (h.type !== 'command' || !h.command) continue
          out.push(
            HookConfigSchema.parse({
              event,
              command: expandRoot(h.command, dir),
              match: group.matcher ? { tool: group.matcher } : {},
              timeout_ms: h.timeout ? h.timeout * 1000 : undefined,
              format: 'claude-code',
              cwd: dir,
            }),
          )
        }
      }
    }
    return out
  } catch (err) {
    errors.push({ file, message: describe(err) })
    return []
  }
}

function mapTools(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : []
  const mapped = list.map((t) => t.trim()).filter(Boolean).map((t) => claudeToolMap[t] ?? t.toLowerCase())
  const known = new Set(['list_dir', 'read_file', 'search', 'write_file', 'edit_file', 'run_command', 'git'])
  const filtered = mapped.filter((t) => known.has(t))
  return filtered.length > 0 ? [...new Set(filtered)] : ['list_dir', 'read_file', 'search']
}

/** Troca a raiz do plugin pelo caminho e cada campo de configuracao do usuario pela variavel de ambiente de mesmo nome em maiusculas. */
export function expandRoot(value: string, dir: string): string {
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, dir)
    .replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, campo: string) => `\${${campo.toUpperCase()}}`)
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z0-9]/, 'p')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mapValues<T>(obj: Record<string, unknown>, fn: (v: unknown) => T): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v)
  return out
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
