import type { Message } from '../types.js'

const charsPerToken = 4

/** Aproximacao grosseira de tokens por tamanho de texto, corrigida pelo uso real na chamada seguinte. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / charsPerToken)
}

export function approxMessageTokens(messages: Message[]): number {
  let total = 0
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text') total += approxTokens(p.text)
      if (p.type === 'tool_call') total += approxTokens(p.rawArgs ?? JSON.stringify(p.args ?? {})) + 8
      if (p.type === 'tool_result') total += approxTokens(p.content) + 8
    }
  }
  return total
}

/** Estima a entrada da proxima chamada: ultimo input real da sessao mais o que foi acrescentado desde entao. */
export function estimateNextInput(lastInput: number | null, appended: Message[], fallbackAll: Message[], system: string): number {
  if (lastInput === null) return approxTokens(system) + approxMessageTokens(fallbackAll)
  return lastInput + approxMessageTokens(appended)
}
