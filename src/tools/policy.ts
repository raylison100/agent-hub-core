import type { Decision, Policy, Risk, ToolDefinition } from '../types.js'

const destructivePatterns: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(\s|$)/i,
  /\brm\s+-rf\s+~\/?(\s|$)/i,
  /\bgit\s+push\b.*(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b.*-[a-z]*f/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b|\breboot\b/i,
]

export const defaultPolicy: Policy = { read: 'allow', write: 'ask', exec: 'ask' }

/** Decide se uma chamada de ferramenta executa, pergunta ou e negada. Padroes destrutivos sempre perguntam. */
export function decide(policy: Policy, def: ToolDefinition, args: Record<string, unknown>): Decision {
  const base = policy[def.risk]
  if (base === 'deny') return 'deny'
  if (def.risk === 'exec' && isDestructive(args)) return 'ask'
  return base
}

export function isDestructive(args: Record<string, unknown>): boolean {
  const command = typeof args.command === 'string' ? args.command : JSON.stringify(args)
  return destructivePatterns.some((p) => p.test(command))
}

/** Classifica uma ferramenta MCP pelo mapa de risco do servidor, com curinga por prefixo. */
export function riskFor(name: string, riskMap: Record<string, Risk>): Risk {
  const exact = riskMap[name]
  if (exact) return exact
  const prefixes = Object.keys(riskMap)
    .filter((k) => k.endsWith('*') && k !== '*')
    .sort((a, b) => b.length - a.length)
  for (const p of prefixes) {
    if (name.startsWith(p.slice(0, -1))) return riskMap[p]!
  }
  return riskMap['*'] ?? 'write'
}
