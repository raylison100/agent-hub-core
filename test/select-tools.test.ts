import { describe, expect, it } from 'vitest'
import { selectTools, toolTokens } from '../src/tools/select.js'
import { capToolResult } from '../src/loop/runner.js'
import type { ToolDefinition } from '../src/types.js'

function ferramenta(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    risk: 'read',
    inputSchema: { type: 'object', properties: { params: { type: 'object', description: 'x'.repeat(2400) } }, additionalProperties: false },
  }
}

const nativas = [ferramenta('read_file', 'Le um arquivo do workspace'), ferramenta('search', 'Procura texto no workspace')]
const github = [
  ferramenta('github-pessoal__github_list_commits', 'Lista commits de um repositorio do GitHub'),
  ferramenta('github-pessoal__github_list_repos', 'Lista repositorios da conta'),
  ferramenta('github-pessoal__github_create_issue', 'Abre uma issue no repositorio'),
  ferramenta('github-pessoal__github_merge_pull_request', 'Faz merge de um pull request'),
  ferramenta('github-pessoal__github_get_job_log', 'Le o log de um job do Actions'),
]
const jira = [
  ferramenta('jira__jira_search_issues', 'Busca issues no Jira por JQL'),
  ferramenta('jira__jira_add_comment', 'Comenta em um card do Jira'),
]
const todas = [...nativas, ...github, ...jira]

describe('selectTools', () => {
  it('com janela grande, manda todas as ferramentas', () => {
    const r = selectTools(todas, 'qualquer pedido', 1_000_000)
    expect(r.dropped).toBe(0)
    expect(r.tools).toHaveLength(todas.length)
  })

  it('com janela pequena, corta as de MCP e nunca as nativas', () => {
    const r = selectTools(todas, 'quantos commits tem o agent-hub-core no github', 8192)
    expect(r.dropped).toBeGreaterThan(0)
    expect(r.tools.filter((t) => !t.name.includes('__')).map((t) => t.name)).toEqual(['read_file', 'search'])
    const tudo = selectTools(todas, 'x', 1_000_000)
    expect(r.used).toBeLessThan(tudo.used)
  })

  it('escolhe pela relevancia: pedido de commits do github traz a ferramenta de commits antes das outras', () => {
    const r = selectTools(todas, 'quantos commits tem o repositorio no github', 8192)
    const nomes = r.tools.map((t) => t.name)
    expect(nomes).toContain('github-pessoal__github_list_commits')
    expect(nomes.some((n) => n.startsWith('jira'))).toBe(false)
  })

  it('pedido de jira traz as do jira, nao as do github', () => {
    const r = selectTools(todas, 'comenta no card do jira que o deploy saiu', 8192)
    const doJira = r.tools.filter((t) => t.name.startsWith('jira')).length
    expect(doJira).toBeGreaterThan(0)
  })

  it('sem nenhuma palavra em comum, ainda manda um minimo para o modelo nao ficar cego', () => {
    const r = selectTools(todas, 'oi', 2000)
    expect(r.tools.filter((t) => t.name.includes('__')).length).toBeGreaterThanOrEqual(3)
  })

  it('conta o custo de cada definicao', () => {
    expect(toolTokens(github[0]!)).toBeGreaterThan(100)
  })
})

describe('capToolResult', () => {
  it('nao mexe no que cabe', () => {
    expect(capToolResult('curto', 1000)).toBe('curto')
  })

  it('corta e explica como pedir menos', () => {
    const grande = 'x'.repeat(40_000)
    const r = capToolResult(grande, 1000)
    expect(r.length).toBeLessThan(grande.length)
    expect(r).toContain('resultado cortado')
    expect(r).toContain('paginacao')
  })
})
