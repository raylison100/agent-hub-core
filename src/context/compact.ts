import type { Message } from '../types.js'
import { approxMessageTokens, approxTokens } from './estimate.js'

export interface CompactionPolicy {
  window: number
  compactAt: number
}

export type Summarizer = (messages: Message[]) => Promise<string>

const prunedMinLength = 200

export function needsCompaction(estimatedInput: number, policy: CompactionPolicy): boolean {
  return estimatedInput > policy.window * policy.compactAt
}

/** Substitui resultados de ferramenta antigos por uma linha, preservando os ultimos `keep` blocos de resultado. */
export function pruneToolResults(messages: Message[], keep = 4): Message[] {
  const toolIndices = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
  const cut = new Set(toolIndices.slice(0, Math.max(0, toolIndices.length - keep)))
  return messages.map((m, i) => (cut.has(i) ? pruneMessage(m) : m))
}

/** Troca o historico anterior a ultima mensagem do usuario por um resumo, marcado como compactacao. */
export async function compactHistory(messages: Message[], summarize: Summarizer): Promise<Message[]> {
  const cutAt = lastUserTextIndex(messages)
  if (cutAt <= 0) return messages
  const head = messages.slice(0, cutAt)
  const tail = messages.slice(cutAt)
  const summary = await summarize(head)
  return [
    {
      role: 'user',
      kind: 'compaction',
      parts: [{ type: 'text', text: `Resumo da conversa anterior, gerado por compactacao:\n\n${summary}` }],
    },
    { role: 'assistant', parts: [{ type: 'text', text: 'Entendido. Continuo a partir desse resumo.' }] },
    ...tail,
  ]
}

/** Tira do historico chamadas de ferramenta com id ja visto e resultados de chamada ja respondida, que os provedores recusam. */
export function withoutRepeatedToolMessages(messages: Message[]): Message[] {
  const calls = new Set<string>()
  const answered = new Set<string>()
  const out: Message[] = []
  for (const m of messages) {
    const parts = m.parts.filter((p) => {
      if (p.type === 'tool_call') {
        if (calls.has(p.id)) return false
        calls.add(p.id)
      }
      if (p.type === 'tool_result') {
        if (answered.has(p.callId)) return false
        answered.add(p.callId)
      }
      return true
    })
    if (parts.length === 0) continue
    out.push(parts.length === m.parts.length ? m : { ...m, parts })
  }
  return out
}

export function estimateAll(system: string, messages: Message[]): number {
  return approxTokens(system) + approxMessageTokens(messages)
}

function pruneMessage(m: Message): Message {
  return {
    ...m,
    parts: m.parts.map((p) =>
      p.type === 'tool_result' && p.content.length > prunedMinLength
        ? { ...p, content: `[resultado podado por compactacao: ${p.content.length} caracteres]` }
        : p,
    ),
  }
}

function lastUserTextIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && m.kind !== 'compaction' && m.parts.some((p) => p.type === 'text')) return i
  }
  return -1
}
