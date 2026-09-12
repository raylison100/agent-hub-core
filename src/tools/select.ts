import { approxTokens } from '../context/estimate.js'
import type { ToolDefinition } from '../types.js'

export interface ToolSelection {
  tools: ToolDefinition[]
  dropped: number
  budget: number
  used: number
}

const minimoDeFerramentas = 3

/** Quanto custa mandar a definicao desta ferramenta em toda chamada. */
export function toolTokens(t: ToolDefinition): number {
  return approxTokens(`${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`)
}

/**
 * Escolhe quais ferramentas de servidor MCP entram nesta chamada. Catalogo grande nao cabe em modelo pequeno e
 * custa em toda chamada do modelo grande: aqui entram as nativas sempre, e as de MCP por relevancia, ate o teto.
 * O piso de tres ferramentas vence o teto, porque modelo sem ferramenta nenhuma nao resolve nada.
 */
export function selectTools(all: ToolDefinition[], text: string, windowTokens: number, share = 0.25): ToolSelection {
  const nativas = all.filter((t) => !t.name.includes('__'))
  const doMcp = all.filter((t) => t.name.includes('__'))
  const budget = Math.max(0, Math.floor(windowTokens * share))
  const custoDasNativas = nativas.reduce((s, t) => s + toolTokens(t), 0)
  const total = custoDasNativas + doMcp.reduce((s, t) => s + toolTokens(t), 0)
  if (doMcp.length === 0 || total <= budget) return { tools: all, dropped: 0, budget, used: total }

  const termos = palavras(text)
  const ranqueadas = doMcp
    .map((t) => ({ t, pontos: relevancia(t, termos), custo: toolTokens(t) }))
    .sort((a, b) => b.pontos - a.pontos || a.custo - b.custo || a.t.name.localeCompare(b.t.name))

  const escolhidas: ToolDefinition[] = []
  let usado = custoDasNativas
  for (const item of ranqueadas) {
    const cabe = usado + item.custo <= budget
    if (!cabe && escolhidas.length >= minimoDeFerramentas) continue
    escolhidas.push(item.t)
    usado += item.custo
  }
  return {
    tools: [...nativas, ...escolhidas].sort((a, b) => a.name.localeCompare(b.name)),
    dropped: doMcp.length - escolhidas.length,
    budget,
    used: usado,
  }
}

/** Pontos pela coincidencia entre o pedido e o nome do servidor, o nome da ferramenta e a descricao dela. */
function relevancia(t: ToolDefinition, termos: Set<string>): number {
  const [servidor = '', resto = ''] = t.name.split('__')
  let pontos = 0
  for (const p of palavras(servidor)) if (termos.has(p)) pontos += 4
  for (const p of palavras(resto)) if (termos.has(p)) pontos += 3
  for (const p of palavras(t.description)) if (termos.has(p)) pontos += 1
  return pontos
}

function palavras(texto: string): Set<string> {
  return new Set(
    texto
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((p) => p.length >= 3),
  )
}
