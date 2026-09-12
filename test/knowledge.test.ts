import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/knowledge/chunk.js'
import { KnowledgeStore, knowledgeDir } from '../src/knowledge/store.js'
import { knowledgeTool } from '../src/knowledge/tool.js'

function base(): { dir: string; store: KnowledgeStore } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-kb-'))
  mkdirSync(join(dir, knowledgeDir), { recursive: true })
  const db = new Database(':memory:')
  KnowledgeStore.migrate(db)
  return { dir, store: new KnowledgeStore(db) }
}

function doc(dir: string, nome: string, texto: string): void {
  writeFileSync(join(dir, knowledgeDir, nome), texto)
}

describe('chunkText', () => {
  it('quebra em titulo e guarda a faixa de linhas', () => {
    const chunks = chunkText('# Um\nlinha um do primeiro bloco\n\n# Dois\nlinha um do segundo bloco')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.firstLine).toBe(1)
    expect(chunks[1]?.text).toContain('segundo bloco')
    expect(chunks[1]?.firstLine).toBe(4)
  })

  it('descarta trecho curto demais para servir de citacao', () => {
    expect(chunkText('# a\n\n# b')).toHaveLength(0)
  })
})

describe('KnowledgeStore', () => {
  it('indexa, acha pelo conteudo e devolve a citacao', () => {
    const { dir, store } = base()
    doc(dir, 'processo.md', '# Deploy\nO deploy de producao passa por hmg antes da main, sempre com aprovacao do time.\n')
    const r = store.index(dir)
    expect(r.files).toBe(1)
    const hits = store.search(dir, 'como funciona o deploy de producao')
    expect(hits[0]?.file).toBe('processo.md')
    expect(hits[0]?.text).toContain('hmg')
    expect(hits[0]?.firstLine).toBe(1)
  })

  it('nao reindexa arquivo que nao mudou e limpa arquivo apagado', () => {
    const { dir, store } = base()
    doc(dir, 'a.md', '# Um\ntexto suficiente para virar um trecho de busca\n')
    expect(store.index(dir).files).toBe(1)
    expect(store.index(dir).files).toBe(0)
    rmSync(join(dir, knowledgeDir, 'a.md'))
    store.index(dir)
    expect(store.files(dir)).toHaveLength(0)
    expect(store.search(dir, 'texto')).toHaveLength(0)
  })

  it('ignora formato que nao sabe ler', () => {
    const { dir, store } = base()
    doc(dir, 'manual.pdf', 'binario')
    expect(store.index(dir).ignored).toEqual(['manual.pdf'])
  })

  it('busca sem acento acha o texto com acento', () => {
    const { dir, store } = base()
    doc(dir, 'glossario.md', '# Termos\nPedido avulso e a compra feita fora do plano de assinatura.\n')
    store.index(dir)
    expect(store.search(dir, 'o que e pedido avulso')).toHaveLength(1)
  })
})

describe('knowledge_search', () => {
  it('devolve os trechos com a citacao e cobra citacao na resposta', async () => {
    const { dir, store } = base()
    doc(dir, 'processo.md', '# Deploy\nO deploy de producao passa por hmg antes da main.\n')
    store.index(dir)
    const saida = await knowledgeTool(store).handler({ query: 'deploy producao' }, { workspace: dir })
    expect(saida).toContain('[processo.md:1-')
    expect(saida).toContain('Cite assim ao usar')
  })

  it('diz que nao achou em vez de inventar', async () => {
    const { dir, store } = base()
    expect(await knowledgeTool(store).handler({ query: 'qualquer coisa' }, { workspace: dir })).toContain('nada encontrado')
  })
})
