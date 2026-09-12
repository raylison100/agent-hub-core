import { describe, expect, it } from 'vitest'
import { mapAnthropicUsage } from '../src/providers/anthropic.js'
import { mapOpenAICompatibleUsage, toMessages as toOpenAiMessages } from '../src/providers/openai-compatible.js'
import type { Message } from '../src/types.js'

describe('mapAnthropicUsage', () => {
  it('separa entrada, saida e cache', () => {
    const usage = mapAnthropicUsage({
      input_tokens: 120,
      output_tokens: 450,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 500,
    } as never)
    expect(usage).toEqual({ input: 120, output: 450, cacheRead: 3000, cacheWrite: 500, reasoning: 0, missing: false })
  })

  it('marca ausencia de usage', () => {
    expect(mapAnthropicUsage(null).missing).toBe(true)
  })
})

describe('mapOpenAICompatibleUsage', () => {
  it('DeepSeek: acerto de cache sai da entrada e raciocinio sai da saida', () => {
    const usage = mapOpenAICompatibleUsage({
      prompt_tokens: 5000,
      completion_tokens: 900,
      total_tokens: 5900,
      prompt_cache_hit_tokens: 4200,
      prompt_cache_miss_tokens: 800,
      completion_tokens_details: { reasoning_tokens: 300 },
    } as never)
    expect(usage).toEqual({ input: 800, output: 600, cacheRead: 4200, cacheWrite: 0, reasoning: 300, missing: false })
  })

  it('OpenAI: usa cached_tokens de prompt_tokens_details', () => {
    const usage = mapOpenAICompatibleUsage({
      prompt_tokens: 2000,
      completion_tokens: 100,
      total_tokens: 2100,
      prompt_tokens_details: { cached_tokens: 1500 },
      completion_tokens_details: { reasoning_tokens: 0 },
    } as never)
    expect(usage.input).toBe(500)
    expect(usage.cacheRead).toBe(1500)
  })

  it('Ollama: sem campos de cache', () => {
    const usage = mapOpenAICompatibleUsage({ prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } as never)
    expect(usage).toEqual({ input: 300, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false })
  })

  it('marca ausencia de usage', () => {
    expect(mapOpenAICompatibleUsage(undefined).missing).toBe(true)
  })
})

describe('imagem com referencia', () => {
  it('adaptadores ignoram imagem sem base64 em vez de mandar data uri quebrada', () => {
    const mensagem: Message = {
      role: 'user',
      parts: [
        { type: 'text', text: 'olha isso' },
        { type: 'image', mediaType: 'image/png', ref: 'abc123' },
      ],
    }
    const compat = toOpenAiMessages([mensagem])[0]
    expect(typeof compat?.content).toBe('string')
    expect(compat?.content).toBe('olha isso')
  })

  it('com base64 presente, a imagem vai como data uri', () => {
    const mensagem: Message = {
      role: 'user',
      parts: [{ type: 'image', mediaType: 'image/png', data: 'QUJD' }],
    }
    const partes = toOpenAiMessages([mensagem])[0]?.content
    expect(Array.isArray(partes)).toBe(true)
    expect(JSON.stringify(partes)).toContain('data:image/png;base64,QUJD')
  })
})
