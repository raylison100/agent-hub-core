import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { approxTokens } from '../context/estimate.js'
import type { Message } from '../types.js'
import { splitFrontmatter } from './load.js'
import { RuleWhenSchema, matchesWhen, type RuleWhen } from './routing.js'

export const contextDir = '.agent-hub'
export const memoryDir = `${contextDir}/memory`
export const specsDir = `${contextDir}/specs`
export const decisionsDir = `${contextDir}/decisions`

const instructionFiles = ['.claude/CLAUDE.md', 'CLAUDE.md', 'AGENTS.md', `${contextDir}/INSTRUCOES.md`]

export const MemoryFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  activate: RuleWhenSchema.optional(),
  run: z.string().optional(),
  data: z.string().optional(),
  agent: z.string().optional(),
})

export interface MemoryItem {
  name: string
  description: string
  activate?: RuleWhen
  run?: string
  data?: string
  agent?: string
  body: string
  file: string
  tokens: number
}

export interface WorkspaceContext {
  text: string
  memoryText: string
  instructions: { file: string; tokens: number }[]
  memories: { name: string; file: string; tokens: number }[]
  inHistory: string[]
  ignored: { name: string; reason: string }[]
  tokens: number
}

export interface ContextOptions {
  text: string
  windowTokens: number
  maxShare?: number
  delivered?: Set<string>
}

/** Le a memoria do workspace, uma por arquivo, ignorando o que nao da para validar. */
export function loadMemories(workspace: string): MemoryItem[] {
  const dir = join(workspace, memoryDir)
  if (!existsSync(dir)) return []
  const items: MemoryItem[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8')
      const { data, body } = splitFrontmatter(raw)
      const front = MemoryFrontmatterSchema.parse(data)
      if (body.trim() === '') continue
      items.push({ ...front, body: body.trim(), file: `${memoryDir}/${file}`, tokens: approxTokens(body) })
    } catch {
      continue
    }
  }
  return items
}

/** Identidade de um item de memoria: muda quando o nome ou o conteudo mudam. */
export function memoryHash(name: string, body: string): string {
  return createHash('sha256').update(`${name}\n${body}`).digest('hex').slice(0, 12)
}

/** Hashes dos itens de memoria que ja chegaram ao modelo nas mensagens desta conversa. */
export function deliveredMemories(messages: Message[]): Set<string> {
  const out = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const p of m.parts) {
      if (p.type !== 'text') continue
      for (const achado of p.text.matchAll(/<item nome="[^"]*" hash="([0-9a-f]{12})"/g)) out.add(achado[1]!)
    }
  }
  return out
}

/**
 * Monta o contexto do projeto dentro de um teto de tokens proporcional a janela do modelo. Instrucoes e glossario
 * vao em `text`, para o system, e nao dependem do pedido. A memoria ativada pelo pedido vai em `memoryText`, para a
 * mensagem do usuario, sem repetir o que ja esta no historico (`delivered`).
 */
export function loadWorkspaceContext(workspace: string, opts: ContextOptions): WorkspaceContext {
  const teto = Math.floor(opts.windowTokens * (opts.maxShare ?? 0.15))
  const out: WorkspaceContext = { text: '', memoryText: '', instructions: [], memories: [], inHistory: [], ignored: [], tokens: 0 }
  const blocos: string[] = []
  let usados = 0

  for (const rel of instructionFiles) {
    const full = join(workspace, rel)
    if (!existsSync(full)) continue
    const conteudo = readFileSync(full, 'utf8').trim()
    if (!conteudo) continue
    const custo = approxTokens(conteudo)
    if (usados + custo > teto) {
      out.ignored.push({ name: rel, reason: `passaria do teto de ${teto} tokens` })
      continue
    }
    usados += custo
    out.instructions.push({ file: rel, tokens: custo })
    blocos.push(`<instrucoes_do_projeto arquivo="${rel}">\n${conteudo}\n</instrucoes_do_projeto>`)
    break
  }

  const glossario = join(workspace, `${contextDir}/glossario.md`)
  if (existsSync(glossario)) {
    const conteudo = readFileSync(glossario, 'utf8').trim()
    const custo = approxTokens(conteudo)
    if (conteudo && usados + custo <= teto) {
      usados += custo
      out.instructions.push({ file: `${contextDir}/glossario.md`, tokens: custo })
      blocos.push(`<glossario_do_projeto>\nTermos deste dominio. Use as palavras do time, nao sinonimos seus.\n${conteudo}\n</glossario_do_projeto>`)
    } else if (conteudo) {
      out.ignored.push({ name: 'glossario.md', reason: `passaria do teto de ${teto} tokens` })
    }
  }

  const ativas = loadMemories(workspace)
    .filter((m) => {
      if (!m.activate) return true
      const casa = matchesWhen(m.activate, { text: opts.text, workspace })
      if (!casa) out.ignored.push({ name: m.name, reason: 'regra de ativação não casou com o pedido' })
      return casa
    })
    .sort((a, b) => (b.data ?? '').localeCompare(a.data ?? '') || a.name.localeCompare(b.name))

  const memoria: string[] = []
  for (const m of ativas) {
    const hash = memoryHash(m.name, m.body)
    if (opts.delivered?.has(hash)) {
      out.inHistory.push(m.name)
      continue
    }
    if (usados + m.tokens > teto) {
      out.ignored.push({ name: m.name, reason: `passaria do teto de ${teto} tokens` })
      continue
    }
    usados += m.tokens
    out.memories.push({ name: m.name, file: m.file, tokens: m.tokens })
    memoria.push(`<item nome="${m.name}" hash="${hash}"${m.data ? ` data="${m.data}"` : ''}${m.run ? ` run="${m.run}"` : ''}>\n${m.body}\n</item>`)
  }
  if (memoria.length > 0) {
    out.memoryText = `<memoria_do_projeto>\nFatos gravados em runs anteriores. Confira no codigo antes de agir sobre um item; se estiver errado, corrija com memory_write. Item com o mesmo nome de outro que ja apareceu na conversa substitui o anterior.\n${memoria.join('\n')}\n</memoria_do_projeto>`
  }

  out.text = blocos.join('\n\n')
  out.tokens = usados
  return out
}
