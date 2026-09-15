import { describe, expect, it } from 'vitest'
import { validateCall } from '../src/tools/validate.js'
import type { ToolDefinition } from '../src/types.js'

function tool(inputSchema: Record<string, unknown>): ToolDefinition {
  return { name: 'navegar', description: 'abre uma pagina', inputSchema, risk: 'read' } as unknown as ToolDefinition
}

describe('validateCall com schemas de servidores MCP', () => {
  it('aceita schema declarado como JSON Schema 2020-12', () => {
    const def = tool({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    })
    expect(validateCall(def, '{"url":"https://exemplo.com"}')).toEqual({ ok: true, args: { url: 'https://exemplo.com' } })
    expect(validateCall(def, '{}').ok).toBe(false)
  })

  it('schema que nao compila deixa os argumentos passarem em vez de derrubar o run', () => {
    const def = tool({ type: 'object', properties: { a: { $ref: '#/nao/existe' } } })
    expect(validateCall(def, { a: 1 })).toEqual({ ok: true, args: { a: 1 } })
  })
})
