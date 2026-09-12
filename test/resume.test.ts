import { describe, expect, it } from 'vitest'
import { parseResume, renderResume, resumeTranscript } from '../src/agents/resume.js'
import type { Message } from '../src/types.js'

const completo = JSON.stringify({
  tarefa: 'corrigir o teste de pontuacao',
  status: 'em andamento',
  proximo_passo: 'rodar pnpm test em core',
  pendencias: ['conferir o caso de janela cheia'],
  arquivos: ['core/src/agents/scoring.ts'],
  notas: ['o feedback ruim derruba a capacidade em 0.05'],
})

describe('parseResume', () => {
  it('le o JSON e aplica os padroes', () => {
    const r = parseResume(`\`\`\`json\n${completo}\n\`\`\``)
    expect(r?.tarefa).toBe('corrigir o teste de pontuacao')
    expect(r?.arquivos).toEqual(['core/src/agents/scoring.ts'])
  })

  it('aceita texto em volta do JSON', () => {
    const r = parseResume(`Claro! Aqui esta: ${completo} espero ter ajudado`)
    expect(r?.status).toBe('em andamento')
  })

  it('recusa status inventado e resposta sem JSON', () => {
    expect(parseResume(JSON.stringify({ tarefa: 'x', status: 'quase la' }))).toBeNull()
    expect(parseResume('nao sei responder')).toBeNull()
  })

  it('preenche listas vazias quando o modelo so manda o minimo', () => {
    const r = parseResume(JSON.stringify({ tarefa: 'x', status: 'travada' }))
    expect(r).toEqual({ tarefa: 'x', status: 'travada', proximo_passo: '', pendencias: [], arquivos: [], notas: [] })
  })
})

describe('renderResume', () => {
  it('monta a versao legivel sem secao vazia', () => {
    const texto = renderResume(parseResume(JSON.stringify({ tarefa: 'x', status: 'concluida' }))!)
    expect(texto).toBe('Tarefa: x\n\nStatus: concluida')
  })
})

describe('resumeTranscript', () => {
  const messages: Message[] = [
    { role: 'user', parts: [{ type: 'text', text: 'leia a.ts' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
    { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', name: 'read_file', content: 'conteudo do arquivo' }] },
  ]

  it('achata a conversa com chamadas e resultados', () => {
    const t = resumeTranscript(messages)
    expect(t).toContain('user: leia a.ts')
    expect(t).toContain('[chamou read_file')
    expect(t).toContain('[resultado: conteudo do arquivo]')
  })

  it('corta o inicio quando passa do limite', () => {
    const t = resumeTranscript(messages, 40)
    expect(t.startsWith('[inicio cortado]')).toBe(true)
    expect(t.length).toBeLessThan(80)
  })
})
