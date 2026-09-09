import { describe, expect, it } from 'vitest'
import { activatedSkills, classifyIntent, route, type Routing } from '../src/agents/routing.js'
import { compactHistory, needsCompaction, pruneToolResults } from '../src/context/compact.js'
import { Redactor } from '../src/tools/redact.js'
import type { Message } from '../src/types.js'

const big = 'x'.repeat(500)

function conversation(): Message[] {
  return [
    { role: 'user', parts: [{ type: 'text', text: 'primeira pergunta' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }] },
    { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: big, isError: false }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'resposta 1' }] },
    { role: 'user', parts: [{ type: 'text', text: 'segunda pergunta' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c2', name: 'read_file', args: {} }] },
    { role: 'tool', parts: [{ type: 'tool_result', callId: 'c2', content: big, isError: false }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'resposta 2' }] },
    { role: 'user', parts: [{ type: 'text', text: 'terceira pergunta' }] },
  ]
}

describe('compactacao', () => {
  it('needsCompaction respeita a fracao da janela', () => {
    expect(needsCompaction(71, { window: 100, compactAt: 0.7 })).toBe(true)
    expect(needsCompaction(70, { window: 100, compactAt: 0.7 })).toBe(false)
  })

  it('poda resultados antigos e preserva os ultimos', () => {
    const pruned = pruneToolResults(conversation(), 1)
    const first = pruned[2]!.parts[0]
    const last = pruned[6]!.parts[0]
    expect(first?.type === 'tool_result' && first.content).toContain('podado')
    expect(last?.type === 'tool_result' && last.content).toBe(big)
  })

  it('compacta tudo antes da ultima mensagem do usuario em um resumo marcado', async () => {
    const result = await compactHistory(conversation(), async (head) => `resumo de ${head.length} mensagens`)
    expect(result).toHaveLength(3)
    expect(result[0]?.kind).toBe('compaction')
    expect(result[0]?.parts[0]?.type === 'text' && result[0].parts[0].text).toContain('resumo de 8 mensagens')
    expect(result[2]?.parts[0]?.type === 'text' && result[2].parts[0].text).toBe('terceira pergunta')
  })
})

describe('Redactor', () => {
  it('substitui chaves e aceita flag inline', () => {
    const r = new Redactor(['sk-ant-[A-Za-z0-9_-]{20,}', '(?i)(password|senha)\\s*[=:]\\s*[\'"][^\'"]{8,}[\'"]'])
    const out = r.redact('key=sk-ant-abcdefghijklmnopqrstuvwxyz SENHA: "supersegredo123"')
    expect(out).not.toContain('sk-ant-abc')
    expect(out).not.toContain('supersegredo123')
    expect(out.match(/\[redacted\]/g)).toHaveLength(2)
  })
})

const routing: Routing = {
  intents: { revisar: ['revisar', 'review', 'mr'], explicar: ['explica', 'o que faz'] },
  rules: [
    { when: { workspace: '**/meu-projeto/**', intent: 'revisar' }, agent: 'claude-arquiteto' },
    { when: { files: ['*.test.ts', '*Test.php'] }, agent: 'deepseek-dev' },
    { when: { prompt_tokens_lt: 40, intent: 'explicar' }, agent: 'local-leitor' },
  ],
}

describe('roteamento', () => {
  it('classifica intencao por palavra inteira', () => {
    expect(classifyIntent('pode revisar o MR 12?', routing.intents)).toBe('revisar')
    expect(classifyIntent('mrs nao contam', routing.intents)).toBeNull()
  })

  it('primeira regra que casa vence', () => {
    expect(route(routing, { text: 'revisar o MR', workspace: '/home/x/Projects/meu-projeto/api' })?.agent).toBe('claude-arquiteto')
    expect(route(routing, { text: 'corrige tests/FooTest.php', workspace: '/tmp' })?.agent).toBe('deepseek-dev')
    expect(route(routing, { text: 'explica isso', workspace: '/tmp' })?.agent).toBe('local-leitor')
    expect(route(routing, { text: 'faz um deploy', workspace: '/tmp' })).toBeNull()
  })

  it('ativa skill por regra apenas quando o perfil a lista', () => {
    const skills = new Map([
      ['revisar-mr', { name: 'revisar-mr', description: '', dir: '', body: '...', activate: { intent: 'revisar' } }],
      ['outra', { name: 'outra', description: '', dir: '', body: '...', activate: { intent: 'revisar' } }],
    ])
    const ctx = { text: 'revisar o MR', workspace: '/tmp' }
    expect(activatedSkills(skills, ['revisar-mr'], ctx, routing.intents).map((s) => s.name)).toEqual(['revisar-mr'])
    expect(activatedSkills(skills, [], ctx, routing.intents)).toHaveLength(0)
  })
})
