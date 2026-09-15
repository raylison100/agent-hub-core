import { describe, expect, it } from 'vitest'
import { parseRole } from '../src/agents/load.js'
import { roleDetail, serializeRole } from '../src/agents/role-file.js'
import type { RoleDetail } from '../src/protocol/frames.js'

const papel: RoleDetail = {
  name: 'revisor',
  description: 'Revisa textos: aponta erros e sugere melhorias',
  models: ['gemini', 'claude'],
  tools: { native: ['read_file', 'search'], mcp: ['conector-exemplo'] },
  skills: ['plugin:revisao'],
  policy: 'somente-leitura',
  max_steps: 40,
  budget: { run_usd: 0.5 },
  prompt: 'Você revisa textos.\n\n- Seja direto.',
}

describe('arquivo de papel', () => {
  it('ida e volta preserva todos os campos editaveis', () => {
    const texto = serializeRole(papel)
    const lido = roleDetail(parseRole('revisor.md', texto))
    expect(lido).toEqual({ ...papel, budget: { run_usd: 0.5, session_usd: undefined } })
  })

  it('omite campos vazios e recusa papel invalido', () => {
    const texto = serializeRole({ ...papel, tools: { native: [], mcp: [] }, skills: [], policy: null, max_steps: null, budget: {} })
    expect(texto).not.toContain('tools:')
    expect(texto).not.toContain('budget:')
    expect(() => serializeRole({ ...papel, name: 'Nome Invalido' })).toThrow()
    expect(() => serializeRole({ ...papel, prompt: '  ' })).toThrow()
  })
})
