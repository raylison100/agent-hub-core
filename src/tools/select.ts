import { approxTokens } from '../context/estimate.js'
import type { ToolDefinition } from '../types.js'

export interface ToolSelection {
  tools: ToolDefinition[]
  dropped: number
  budget: number
  used: number
  mcp: string[]
  reused: boolean
}

const minimoDeFerramentas = 3
const pontosDeCitacao = 3

/** Quanto custa mandar a definicao desta ferramenta em toda chamada. */
export function toolTokens(t: ToolDefinition): number {
  return approxTokens(`${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`)
}

/**
 * Escolhe quais ferramentas de servidor MCP entram nesta chamada. Catalogo grande nao cabe em modelo pequeno e
 * custa em toda chamada do modelo grande: aqui entram as nativas sempre, e as de MCP por relevancia, ate o teto.
 * O piso de tres ferramentas vence o teto, porque modelo sem ferramenta nenhuma nao resolve nada.
 * Com `previous`, repete o conjunto da mensagem anterior da sessao enquanto ele couber e o pedido nao citar
 * servidor ou ferramenta de fora dele.
 */
export function selectTools(all: ToolDefinition[], text: string, windowTokens: number, share = 0.25, previous?: string[]): ToolSelection {
  const nativas = all.filter((t) => !t.name.includes('__'))
  const doMcp = all.filter((t) => t.name.includes('__'))
  const budget = Math.max(0, Math.floor(windowTokens * share))
  const custoDasNativas = nativas.reduce((s, t) => s + toolTokens(t), 0)
  const total = custoDasNativas + doMcp.reduce((s, t) => s + toolTokens(t), 0)
  if (doMcp.length === 0 || total <= budget) return { tools: all, dropped: 0, budget, used: total, mcp: doMcp.map((t) => t.name), reused: false }

  const termos = palavras(text)
  const anterior = new Set(previous ?? [])
  const mantidas = doMcp.filter((t) => anterior.has(t.name))
  if (mantidas.length > 0) {
    const custo = custoDasNativas + mantidas.reduce((s, t) => s + toolTokens(t), 0)
    const citadaDeFora = doMcp.some((t) => !anterior.has(t.name) && relevancia(t, termos) >= pontosDeCitacao)
    if (!citadaDeFora && (custo <= budget || mantidas.length <= minimoDeFerramentas)) {
      return montar(nativas, mantidas, doMcp.length, budget, custo, true)
    }
  }

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
  return montar(nativas, escolhidas, doMcp.length, budget, usado, false)
}

function montar(nativas: ToolDefinition[], escolhidas: ToolDefinition[], totalMcp: number, budget: number, used: number, reused: boolean): ToolSelection {
  return {
    tools: [...nativas, ...escolhidas].sort((a, b) => a.name.localeCompare(b.name)),
    dropped: totalMcp - escolhidas.length,
    budget,
    used,
    mcp: escolhidas.map((t) => t.name).sort(),
    reused,
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
