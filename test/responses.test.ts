import { describe, expect, it } from 'vitest'
import { buildResponsesAssistant, mapResponsesUsage, toResponsesInput } from '../src/providers/index.js'
import type { Message } from '../src/types.js'

const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'cifrado' }
const callItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }
const messageItem = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'pronto', annotations: [] }] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const output = [reasoningItem, callItem, messageItem] as any

describe('mapResponsesUsage', () => {
  it('separa cache e raciocinio das contagens cheias', () => {
    const usage = mapResponsesUsage({
      input_tokens: 1000,
      output_tokens: 300,
      total_tokens: 1300,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 120 },
    })
    expect(usage).toEqual({ input: 500, output: 180, cacheRead: 400, cacheWrite: 100, reasoning: 120, missing: false })
  })

  it('marca ausente quando a resposta nao traz uso', () => {
    expect(mapResponsesUsage(null).missing).toBe(true)
  })
})

describe('buildResponsesAssistant', () => {
  it('extrai texto e chamada de ferramenta e guarda os itens originais', () => {
    const message = buildResponsesAssistant(output)
    expect(message.parts[0]).toEqual({ type: 'text', text: 'pronto' })
    expect(message.parts[1]).toMatchObject({ type: 'tool_call', id: 'call_1', name: 'read_file', args: { path: 'a.ts' } })
    expect(message.rawProvider).toBe('openai-responses')
  })
})

describe('toResponsesInput', () => {
  it('reenvia os itens originais do assistente, preservando o raciocinio cifrado', () => {
    const history: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'leia a.ts' }] },
      buildResponsesAssistant(output),
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'call_1', name: 'read_file', content: 'conteudo' }] },
    ]
    const input = toResponsesInput(history) as Record<string, unknown>[]
    expect(input[0]).toEqual({ role: 'user', content: 'leia a.ts' })
    expect(input[1]).toMatchObject({ type: 'reasoning', encrypted_content: 'cifrado' })
    expect(input[2]).toMatchObject({ type: 'function_call', call_id: 'call_1' })
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'conteudo' })
  })

  it('sem itens originais, remonta texto e chamada a partir das partes', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'vou ler' },
          { type: 'tool_call', id: 'call_2', name: 'search', args: { q: 'x' } },
        ],
      },
    ]
    const input = toResponsesInput(history) as Record<string, unknown>[]
    expect(input[0]).toEqual({ role: 'assistant', content: 'vou ler' })
    expect(input[1]).toEqual({ type: 'function_call', call_id: 'call_2', name: 'search', arguments: '{"q":"x"}' })
  })
})
