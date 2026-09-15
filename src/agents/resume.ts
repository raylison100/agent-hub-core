import { z } from 'zod'
import type { Message } from '../types.js'

export const ResumeSchema = z.object({
  tarefa: z.string().min(1),
  status: z.enum(['em andamento', 'concluida', 'travada']),
  proximo_passo: z.string().default(''),
  pendencias: z.array(z.string()).default([]),
  arquivos: z.array(z.string()).default([]),
  notas: z.array(z.string()).default([]),
})

export type SessionResume = z.infer<typeof ResumeSchema>

export const resumeSystem =
  'Voce escreve o ponto de retomada de uma conversa entre um usuario e um agente de programacao, para quem voltar ' +
  'dias depois saber onde parou. Use apenas o que esta na conversa: nao invente arquivo, decisao nem pendencia. ' +
  'Responda apenas com JSON valido, sem texto ao redor e sem cerca de codigo.'

export const resumeJsonSchema = {
  type: 'object',
  properties: {
    tarefa: { type: 'string', description: 'o que o usuario pediu, em uma frase' },
    status: { type: 'string', enum: ['em andamento', 'concluida', 'travada'] },
    proximo_passo: { type: 'string', description: 'a proxima acao concreta, ou vazio se nao houver' },
    pendencias: { type: 'array', items: { type: 'string' } },
    arquivos: { type: 'array', items: { type: 'string' }, description: 'caminhos citados ou tocados' },
    notas: { type: 'array', items: { type: 'string' }, description: 'decisoes tomadas e armadilhas encontradas' },
  },
  required: ['tarefa', 'status'],
  additionalProperties: false,
}

/** Transcricao curta da conversa para o modelo barato montar o ponto de retomada. */
export function resumeTranscript(messages: Message[], maxChars = 12000): string {
  const linhas = messages.map((m) => {
    const partes = m.parts.map((p) => {
      if (p.type === 'text') return p.text
      if (p.type === 'tool_call') return `[chamou ${p.name} ${JSON.stringify(p.args ?? {}).slice(0, 160)}]`
      if (p.type === 'image') return `[imagem ${p.name ?? p.mediaType}]`
      if (p.type === 'tool_result') return `[resultado${p.isError ? ' com erro' : ''}: ${p.content.slice(0, 200)}]`
      return ''
    })
    return `${m.role}: ${partes.filter(Boolean).join(' ')}`
  })
  const texto = linhas.join('\n')
  return texto.length <= maxChars ? texto : `[inicio cortado]\n${texto.slice(texto.length - maxChars)}`
}

export function resumePrompt(transcript: string): string {
  return `Conversa:\n\n${transcript}\n\nEscreva o ponto de retomada nesta forma:\n${JSON.stringify(resumeJsonSchema)}`
}

/** Le a resposta do modelo, aceitando cerca de codigo em volta. Devolve null quando nao da para confiar. */
export function parseResume(text: string): SessionResume | null {
  const limpo = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const inicio = limpo.indexOf('{')
  const fim = limpo.lastIndexOf('}')
  if (inicio === -1 || fim <= inicio) return null
  try {
    const parsed = ResumeSchema.safeParse(JSON.parse(limpo.slice(inicio, fim + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Versao legivel do ponto de retomada, usada na interface e ao bifurcar a sessao. */
export function renderResume(r: SessionResume): string {
  const blocos = [`Tarefa: ${r.tarefa}`, `Status: ${r.status}`]
  if (r.proximo_passo) blocos.push(`Próximo passo: ${r.proximo_passo}`)
  if (r.pendencias.length) blocos.push(`Pendências:\n${r.pendencias.map((p) => `- ${p}`).join('\n')}`)
  if (r.arquivos.length) blocos.push(`Arquivos:\n${r.arquivos.map((a) => `- ${a}`).join('\n')}`)
  if (r.notas.length) blocos.push(`Notas:\n${r.notas.map((n) => `- ${n}`).join('\n')}`)
  return blocos.join('\n\n')
}
