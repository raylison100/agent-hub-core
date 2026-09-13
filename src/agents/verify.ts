import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Message } from '../types.js'

export const verificationChecks = ['parada', 'resposta', 'fundamentacao', 'citacoes', 'ferramentas'] as const

export type VerificationCheck = (typeof verificationChecks)[number]

export const CascadeSchema = z.object({
  agent: z.string(),
  escalate_to: z.string().optional(),
  intents: z.array(z.string()).default(['explicar']),
  checks: z.array(z.enum(verificationChecks)).default([...verificationChecks]),
  max_prompt_tokens: z.number().int().positive().optional(),
})

export type Cascade = z.infer<typeof CascadeSchema>

export interface VerificationFailure {
  check: VerificationCheck
  reason: string
}

export interface Verification {
  ok: boolean
  failures: VerificationFailure[]
  citations: number
}

export interface VerificationInput {
  stop: string
  appended: Message[]
  workspace: string
}

const naoAchou = /\bn[aã]o (foi |foram )?(encontrad[oa]s?|localizad[oa]s?)|\bn[aã]o (est[aá]|esta) definid[oa]|\bn[aã]o consegui (encontrar|localizar|achar)|\bn[aã]o existe no (codigo|código|workspace)/i
const citacaoDeExemplo = /\[?\barquivo:(linha|\d)|\[arquivo\]/i
const vazamento = /^\s*(<think>|okay,? let'?s|alright,? let'?s|let me (think|see)|first, i need to|hmm,? )/i
const citacao = /(?<![\w/.-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[a-z][a-z0-9]{0,6})(?::(\d+)(?:-(\d+))?)?(?![\w/])/gi
const ignorados = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.next'])
const extensoesDeCodigo = /\.(ts|tsx|js|mjs|cjs|vue|json|md|yaml|yml|toml|py|go|php|rs|java|kt|sql|sh|css|html)$/i

/** Confere por codigo o resultado de um run: como parou, se ha resposta, se as citacoes existem e se as ferramentas funcionaram. */
export function verifyRun(input: VerificationInput, checks: readonly VerificationCheck[] = verificationChecks): Verification {
  const failures: VerificationFailure[] = []
  const resposta = finalText(input.appended)
  let citations = 0

  if (checks.includes('parada') && input.stop !== 'end') failures.push({ check: 'parada', reason: `run terminou com ${input.stop}` })

  if (checks.includes('resposta')) {
    if (resposta.trim() === '') failures.push({ check: 'resposta', reason: 'resposta vazia' })
    else if (vazamento.test(resposta)) failures.push({ check: 'resposta', reason: 'resposta comeca com raciocinio vazado' })
    else if (naoAchou.test(resposta)) failures.push({ check: 'resposta', reason: 'o modelo diz que nao encontrou a resposta' })
  }

  const lido = toolText(input.appended)
  if (checks.includes('fundamentacao') && lido.ok === 0) {
    failures.push({ check: 'fundamentacao', reason: 'respondeu sem nenhuma leitura bem-sucedida do workspace' })
  }

  if (checks.includes('citacoes') && resposta) {
    if (citacaoDeExemplo.test(resposta)) failures.push({ check: 'citacoes', reason: 'usa citacao de exemplo, sem arquivo real' })
    const vistos = new Set<string>()
    for (const achado of resposta.matchAll(citacao)) {
      const caminho = achado[1]!
      const linha = achado[2] ? Number(achado[2]) : undefined
      if (!linha && !extensoesDeCodigo.test(caminho)) continue
      if (/^\d/.test(caminho) || caminho.includes('..')) continue
      if (!linha && /^[A-Z][a-z]+\.js$/.test(caminho)) continue
      const chave = `${caminho}:${linha ?? ''}`
      if (vistos.has(chave) || vistos.size >= 20) continue
      vistos.add(chave)
      citations += 1
      const arquivo = locate(input.workspace, caminho)
      if (!arquivo) {
        failures.push({ check: 'citacoes', reason: `cita ${caminho}, que nao existe no workspace` })
        continue
      }
      const nome = caminho.split('/').pop()!
      if (checks.includes('fundamentacao') && !lido.text.includes(nome)) {
        failures.push({ check: 'fundamentacao', reason: `cita ${caminho} sem ter lido nem encontrado esse arquivo neste run` })
        continue
      }
      if (linha) {
        const total = readFileSync(arquivo, 'utf8').split('\n').length
        if (linha > total) failures.push({ check: 'citacoes', reason: `cita ${caminho}:${linha}, mas o arquivo tem ${total} linhas` })
      }
    }
  }

  if (checks.includes('ferramentas')) {
    const resultados = input.appended.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result')
    if (resultados.length > 0 && resultados.every((r) => r.isError)) {
      failures.push({ check: 'ferramentas', reason: `todas as ${resultados.length} chamadas de ferramenta falharam` })
    }
  }

  return { ok: failures.length === 0, failures, citations }
}

/** Argumentos e resultados das ferramentas do run, e quantos resultados vieram sem erro. */
function toolText(messages: Message[]): { text: string; ok: number } {
  const partes: string[] = []
  let ok = 0
  for (const p of messages.flatMap((m) => m.parts)) {
    if (p.type === 'tool_call') partes.push(JSON.stringify(p.args ?? {}))
    if (p.type === 'tool_result') {
      partes.push(p.content)
      if (!p.isError) ok += 1
    }
  }
  return { text: partes.join('\n'), ok }
}

/** Texto da ultima mensagem do assistente que escreveu alguma coisa. */
function finalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    const texto = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    if (texto.trim()) return texto
  }
  return ''
}

/** Acha o arquivo citado: pelo caminho relativo ao workspace ou, se vier so o nome, pela primeira ocorrencia na arvore. */
function locate(workspace: string, caminho: string): string | undefined {
  const direto = resolve(workspace, caminho)
  if (!relative(workspace, direto).startsWith('..') && isFile(direto)) return direto
  const alvo = caminho.split('/')
  let visitados = 0
  const fila = [workspace]
  while (fila.length > 0 && visitados < 5000) {
    const dir = fila.shift()!
    let entradas
    try {
      entradas = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entradas) {
      visitados += 1
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!ignorados.has(e.name)) fila.push(full)
      } else if (e.name === alvo[alvo.length - 1] && full.split(sep).slice(-alvo.length).join('/') === caminho) {
        return full
      }
    }
  }
  return undefined
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}
