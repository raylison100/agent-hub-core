import { describe, expect, it } from 'vitest'
import { parseProfile, parseRole } from '../src/agents/load.js'
import { applyRole } from '../src/agents/schema.js'
import { resolveModel } from '../src/providers/index.js'
import { decide, riskFor } from '../src/tools/policy.js'
import { validateCall } from '../src/tools/validate.js'
import type { ToolDefinition } from '../src/types.js'

const profileText = `---
name: deepseek-dev
description: implementacao do dia a dia
provider: deepseek
model: deepseek-chat
reasoning: medium
tools:
  native: [read_file, edit_file]
context:
  window: 128000
---

Voce implementa codigo.
`

describe('parseProfile', () => {
  it('aplica padroes e preserva o prompt', () => {
    const p = parseProfile('x.md', profileText)
    expect(p.name).toBe('deepseek-dev')
    expect(p.max_steps).toBe(30)
    expect(p.tools.mcp).toEqual([])
    expect(p.cache.system_ttl).toBe('5m')
    expect(p.system).toBe('Voce implementa codigo.')
  })

  it('recusa perfil sem prompt', () => {
    expect(() => parseProfile('x.md', profileText.split('---\n\n')[0] + '---\n')).toThrow()
  })
})

describe('resolveModel', () => {
  it('troca deepseek-chat por deepseek-reasoner em raciocinio alto', () => {
    expect(resolveModel({ provider: 'deepseek', model: 'deepseek-chat', reasoning: 'high' })).toBe('deepseek-reasoner')
    expect(resolveModel({ provider: 'deepseek', model: 'deepseek-chat', reasoning: 'medium' })).toBe('deepseek-chat')
  })
})

const runCommand: ToolDefinition = {
  name: 'run_command',
  description: '',
  risk: 'exec',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' }, timeout_ms: { type: 'integer', default: 1000 } },
    required: ['command'],
    additionalProperties: false,
  },
}

describe('validateCall', () => {
  it('aceita JSON em texto, aplica padrao e remove campo desconhecido', () => {
    const r = validateCall(runCommand, '{"command":"ls","extra":1}')
    expect(r).toEqual({ ok: true, args: { command: 'ls', timeout_ms: 1000 } })
  })

  it('rejeita JSON invalido e campo obrigatorio ausente', () => {
    expect(validateCall(runCommand, '{oops').ok).toBe(false)
    expect(validateCall(runCommand, {}).ok).toBe(false)
  })
})

describe('decide', () => {
  const policy = { read: 'allow', write: 'ask', exec: 'allow' } as const

  it('padrao destrutivo sempre pergunta mesmo com exec allow', () => {
    expect(decide(policy, runCommand, { command: 'rm -rf /' })).toBe('ask')
    expect(decide(policy, runCommand, { command: 'git push --force origin main' })).toBe('ask')
    expect(decide(policy, runCommand, { command: 'ls -la' })).toBe('allow')
  })

  it('deny vence tudo', () => {
    expect(decide({ ...policy, exec: 'deny' }, runCommand, { command: 'ls' })).toBe('deny')
  })
})

describe('riskFor', () => {
  it('usa prefixo mais longo e curinga geral', () => {
    const map = { 'gitlab_get_*': 'read', 'gitlab_list_*': 'read', '*': 'write' } as const
    expect(riskFor('gitlab_get_file', map)).toBe('read')
    expect(riskFor('gitlab_merge_merge_request', map)).toBe('write')
  })
})

const roleText = `---
name: revisor
description: revisa mudanca de codigo
models: [deepseek, claude]
tools:
  native: [read_file, git]
policy: somente-leitura
max_steps: 12
---

Voce revisa codigo e nao altera arquivo.
`

describe('papel separado do modelo', () => {
  it('le o papel com seus modelos e seu prompt', () => {
    const r = parseRole('revisor.md', roleText)
    expect(r.models).toEqual(['deepseek', 'claude'])
    expect(r.policy).toBe('somente-leitura')
    expect(r.system).toBe('Voce revisa codigo e nao altera arquivo.')
  })

  it('aplicar o papel troca prompt, ferramentas e politica mas mantem modelo, janela e preco', () => {
    const merged = applyRole(parseProfile('x.md', profileText), parseRole('revisor.md', roleText))
    expect(merged.name).toBe('deepseek-dev')
    expect(merged.provider).toBe('deepseek')
    expect(merged.context.window).toBe(128000)
    expect(merged.role).toBe('revisor')
    expect(merged.system).toBe('Voce revisa codigo e nao altera arquivo.')
    expect(merged.tools.native).toEqual(['read_file', 'git'])
    expect(merged.policy).toBe('somente-leitura')
    expect(merged.max_steps).toBe(12)
  })

  it('papel sem campo opcional nao apaga o que o perfil ja tinha', () => {
    const semNada = parseRole('p.md', `---\nname: leitor\ndescription: so le\nmodels: [deepseek]\n---\n\nVoce le.\n`)
    const merged = applyRole(parseProfile('x.md', profileText), semNada)
    expect(merged.tools.native).toEqual(['read_file', 'edit_file'])
    expect(merged.max_steps).toBe(30)
  })
})
