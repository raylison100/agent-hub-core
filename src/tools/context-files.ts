import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decisionsDir, loadMemories, memoryDir, specsDir } from '../agents/workspace-context.js'
import type { RegisteredTool } from './registry.js'
import { resolveInside } from './workspace.js'

export function contextTools(): RegisteredTool[] {
  return [memoryRead, memoryWrite, specWrite]
}

const memoryRead: RegisteredTool = {
  definition: {
    name: 'memory_read',
    description:
      'Le a memoria do projeto gravada em runs anteriores. Sem nome, lista os itens com descricao; com nome, devolve o item inteiro. ' +
      'Os itens ativados pelo pedido ja chegam no seu contexto: use isto para procurar o que nao foi carregado.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'nome do item; sem ele, lista todos' } },
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const itens = loadMemories(ctx.workspace)
    if (itens.length === 0) return 'memoria vazia neste workspace'
    const name = typeof args.name === 'string' ? args.name : undefined
    if (!name) return itens.map((m) => `${m.name}: ${m.description || '(sem descricao)'}${m.data ? ` [${m.data}]` : ''}`).join('\n')
    const achado = itens.find((m) => m.name === name)
    return achado ? `${achado.file}\n\n${achado.body}` : `item nao encontrado: ${name}. Itens: ${itens.map((m) => m.name).join(', ')}`
  },
}

const memoryWrite: RegisteredTool = {
  definition: {
    name: 'memory_write',
    description:
      'Grava um fato duravel do projeto, que vale para os proximos runs: convencao do time, armadilha do ambiente, decisao ja tomada. ' +
      'Nao grave o que o codigo ja diz nem o que vale so para esta conversa. Um fato por item. Para apagar, use apagar=true.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'identificador curto em minusculas, com hifens' },
        description: { type: 'string', description: 'uma linha dizendo quando este item importa' },
        body: { type: 'string', description: 'o fato, com o motivo' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'palavras do pedido que ativam o item; sem elas, o item carrega sempre' },
        files: { type: 'array', items: { type: 'string' }, description: 'padroes de arquivo que ativam o item' },
        apagar: { type: 'boolean', default: false },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const name = slug(String(args.name))
    const alvo = resolveInside(ctx.workspace, `${memoryDir}/${name}.md`)
    if (args.apagar === true) {
      if (!existsSync(alvo)) return `nao existia: ${name}`
      writeFileSync(alvo, '')
      return `apagado o conteudo de ${memoryDir}/${name}.md`
    }
    const body = String(args.body ?? '').trim()
    if (!body) throw new Error('body vazio: um item de memoria sem o fato nao serve para nada')
    const activate: Record<string, unknown> = {}
    if (Array.isArray(args.keywords) && args.keywords.length > 0) activate.keywords = args.keywords.map(String)
    if (Array.isArray(args.files) && args.files.length > 0) activate.files = args.files.map(String)
    const front = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(String(args.description ?? ''))}`,
      ...(Object.keys(activate).length > 0 ? [`activate: ${JSON.stringify(activate)}`] : []),
      `run: ${ctx.runId ?? 'desconhecido'}`,
      `agent: ${ctx.agent ?? 'desconhecido'}`,
      `data: ${new Date().toISOString().slice(0, 10)}`,
      '---',
      '',
    ].join('\n')
    mkdirSync(dirname(alvo), { recursive: true })
    writeFileSync(alvo, `${front}${body}\n`)
    return `gravado ${memoryDir}/${name}.md`
  },
}

const specWrite: RegisteredTool = {
  definition: {
    name: 'spec_write',
    description:
      'Grava a especificacao de uma tarefa antes de executar, ou o registro de uma decisao ja tomada. ' +
      'A especificacao serve de contrato para outro agente executar; a decisao guarda o que foi escolhido e por que.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'identificador curto em minusculas, com hifens' },
        kind: { type: 'string', enum: ['spec', 'decisao'], default: 'spec' },
        body: { type: 'string', description: 'texto em markdown' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const kind = args.kind === 'decisao' ? 'decisao' : 'spec'
    const dir = kind === 'decisao' ? decisionsDir : specsDir
    const name = slug(String(args.name))
    const alvo = resolveInside(ctx.workspace, `${dir}/${name}.md`)
    const cabecalho = `<!-- run ${ctx.runId ?? 'desconhecido'}, agente ${ctx.agent ?? 'desconhecido'}, ${new Date().toISOString().slice(0, 10)} -->\n\n`
    mkdirSync(dirname(alvo), { recursive: true })
    writeFileSync(alvo, `${cabecalho}${String(args.body).trim()}\n`)
    return `gravado ${dir}/${name}.md`
  },
}

/** Lista os arquivos de contexto de um workspace, para a interface mostrar e deixar apagar. */
export function listContextFiles(workspace: string, dir: string): { name: string; file: string; bytes: number }[] {
  const full = join(workspace, dir)
  if (!existsSync(full)) return []
  return readdirSync(full)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ''), file: `${dir}/${f}`, bytes: readFileSync(join(full, f), 'utf8').length }))
}

function slug(raw: string): string {
  const limpo = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  if (!limpo) throw new Error(`nome invalido: ${raw}`)
  return limpo
}
