import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deliveredMemories, loadMemories, loadWorkspaceContext, memoryDir } from '../src/agents/workspace-context.js'
import type { Message } from '../src/types.js'
import { contextTools, listContextFiles } from '../src/tools/context-files.js'

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-ctx-'))
  mkdirSync(join(dir, memoryDir), { recursive: true })
  return dir
}

function memoria(dir: string, name: string, front: string, body: string): void {
  writeFileSync(join(dir, memoryDir, `${name}.md`), `---\nname: ${name}\n${front}---\n\n${body}\n`)
}

const ferramentas = new Map(contextTools().map((t) => [t.definition.name, t]))

describe('loadWorkspaceContext', () => {
  it('carrega as instrucoes do projeto e a memoria sem regra', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'CLAUDE.md'), 'Commits em portugues.')
    memoria(dir, 'porta-do-daemon', 'description: "porta"\ndata: 2026-09-12\n', 'O daemon escuta na 47311.')
    const ctx = loadWorkspaceContext(dir, { text: 'qualquer pedido', windowTokens: 100000 })
    expect(ctx.text).toContain('Commits em portugues.')
    expect(ctx.memoryText).toContain('O daemon escuta na 47311.')
    expect(ctx.instructions[0]?.file).toBe('CLAUDE.md')
    expect(ctx.memories.map((m) => m.name)).toEqual(['porta-do-daemon'])
  })

  it('mantem o system igual entre pedidos: memoria ativada vai para a mensagem, nao para o system', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'CLAUDE.md'), 'Commits em portugues.')
    memoria(dir, 'pagamento', 'activate: {"keywords":["cobranca"]}\n', 'O gateway recusa centavos.')
    const primeiro = loadWorkspaceContext(dir, { text: 'ajusta o menu', windowTokens: 100000 })
    const segundo = loadWorkspaceContext(dir, { text: 'corrige a cobranca', windowTokens: 100000 })
    expect(segundo.text).toBe(primeiro.text)
    expect(primeiro.memoryText).toBe('')
    expect(segundo.memoryText).toContain('O gateway recusa centavos.')
  })

  it('nao repete memoria que ja chegou ao modelo nesta conversa, e entrega de novo quando o conteudo muda', () => {
    const dir = workspace()
    memoria(dir, 'porta', '', 'O daemon escuta na 47311.')
    const primeiro = loadWorkspaceContext(dir, { text: 'oi', windowTokens: 100000 })
    const historico: Message[] = [{ role: 'user', parts: [{ type: 'text', text: 'oi' }, { type: 'text', text: primeiro.memoryText, context: true }] }]
    const repetido = loadWorkspaceContext(dir, { text: 'e agora?', windowTokens: 100000, delivered: deliveredMemories(historico) })
    expect(repetido.memoryText).toBe('')
    expect(repetido.inHistory).toEqual(['porta'])
    memoria(dir, 'porta', '', 'O daemon escuta na 47312.')
    const mudou = loadWorkspaceContext(dir, { text: 'e agora?', windowTokens: 100000, delivered: deliveredMemories(historico) })
    expect(mudou.memoryText).toContain('47312')
  })

  it('deixa de fora a memoria cuja regra de ativacao nao casa com o pedido', () => {
    const dir = workspace()
    memoria(dir, 'pagamento', 'activate: {"keywords":["pagamento","cobranca"]}\n', 'O gateway recusa centavos.')
    const fora = loadWorkspaceContext(dir, { text: 'ajusta o layout do menu', windowTokens: 100000 })
    expect(fora.memories).toHaveLength(0)
    expect(fora.ignored[0]?.reason).toContain('ativacao')
    const dentro = loadWorkspaceContext(dir, { text: 'corrige a cobranca do plano', windowTokens: 100000 })
    expect(dentro.memories.map((m) => m.name)).toEqual(['pagamento'])
  })

  it('respeita o teto de tokens proporcional a janela', () => {
    const dir = workspace()
    memoria(dir, 'grande', 'data: 2026-09-12\n', 'x'.repeat(8000))
    const apertado = loadWorkspaceContext(dir, { text: 'oi', windowTokens: 1000 })
    expect(apertado.memories).toHaveLength(0)
    expect(apertado.ignored[0]?.reason).toContain('teto')
    const folgado = loadWorkspaceContext(dir, { text: 'oi', windowTokens: 200000 })
    expect(folgado.memories).toHaveLength(1)
  })

  it('ignora arquivo de memoria invalido em vez de derrubar o run', () => {
    const dir = workspace()
    writeFileSync(join(dir, memoryDir, 'quebrado.md'), '---\nsem_nome: true\n---\n\ncorpo\n')
    memoria(dir, 'bom', '', 'fato util')
    expect(loadMemories(dir).map((m) => m.name)).toEqual(['bom'])
  })
})

describe('ferramentas de contexto', () => {
  it('memory_write grava com proveniencia e memory_read le de volta', async () => {
    const dir = workspace()
    const ctx = { workspace: dir, runId: 'run-123', agent: 'deepseek' }
    const gravado = await ferramentas.get('memory_write')!.handler(
      { name: 'Porta do Daemon', description: 'porta local', body: 'O daemon escuta na 47311.', keywords: ['daemon'] },
      ctx,
    )
    expect(gravado).toContain('porta-do-daemon.md')
    const itens = loadMemories(dir)
    expect(itens[0]?.run).toBe('run-123')
    expect(itens[0]?.agent).toBe('deepseek')
    expect(itens[0]?.data).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await ferramentas.get('memory_read')!.handler({}, ctx)).toContain('porta-do-daemon: porta local')
    expect(await ferramentas.get('memory_read')!.handler({ name: 'porta-do-daemon' }, ctx)).toContain('escuta na 47311')
  })

  it('memory_write recusa item sem fato', async () => {
    const dir = workspace()
    await expect(ferramentas.get('memory_write')!.handler({ name: 'vazio' }, { workspace: dir })).rejects.toThrow('body vazio')
  })

  it('spec_write separa especificacao de decisao', async () => {
    const dir = workspace()
    const ctx = { workspace: dir, runId: 'r', agent: 'claude' }
    await ferramentas.get('spec_write')!.handler({ name: 'trocar-banco', body: '# Plano' }, ctx)
    await ferramentas.get('spec_write')!.handler({ name: 'trocar-banco', kind: 'decisao', body: '# Ficamos no sqlite' }, ctx)
    expect(listContextFiles(dir, '.agent-hub/specs').map((f) => f.name)).toEqual(['trocar-banco'])
    expect(listContextFiles(dir, '.agent-hub/decisions').map((f) => f.name)).toEqual(['trocar-banco'])
  })
})
