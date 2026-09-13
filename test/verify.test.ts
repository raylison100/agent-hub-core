import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CascadeSchema, verifyRun } from '../src/agents/verify.js'
import type { Message } from '../src/types.js'

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-verify-'))
  mkdirSync(join(dir, 'src/loop'), { recursive: true })
  writeFileSync(join(dir, 'src/loop/runner.ts'), Array.from({ length: 40 }, (_, i) => `linha ${i + 1}`).join('\n'))
  writeFileSync(join(dir, 'README.md'), '# projeto\n')
  return dir
}

function leu(...caminhos: string[]): Message[] {
  return caminhos.flatMap((path, i): Message[] => [
    { role: 'assistant', parts: [{ type: 'tool_call', id: `c${i}`, name: 'read_file', args: { path } }] },
    { role: 'tool', parts: [{ type: 'tool_result', callId: `c${i}`, content: `conteudo de ${path}`, isError: false }] },
  ])
}

function resposta(texto: string, antes: Message[] = []): Message[] {
  return [...antes, { role: 'assistant', parts: [{ type: 'text', text: texto }] }]
}

describe('verifyRun', () => {
  it('aceita resposta que leu o que cita, por caminho ou so pelo nome', () => {
    const dir = workspace()
    const r = verifyRun({ stop: 'end', workspace: dir, appended: resposta('O laco fica em src/loop/runner.ts:12 e em runner.ts:30, veja README.md.', leu('src/loop/runner.ts', 'README.md')) })
    expect(r.failures).toEqual([])
    expect(r.citations).toBe(3)
  })

  it('recusa arquivo inventado e linha que passa do fim', () => {
    const dir = workspace()
    const r = verifyRun({ stop: 'end', workspace: dir, appended: resposta('Veja src/loop/planner.ts:3 e src/loop/runner.ts:400.', leu('src/loop/runner.ts')) })
    expect(r.failures.map((f) => f.reason)).toEqual([
      'cita src/loop/planner.ts, que nao existe no workspace',
      'cita src/loop/runner.ts:400, mas o arquivo tem 40 linhas',
    ])
  })

  it('recusa resposta sem nenhuma leitura do workspace', () => {
    const dir = workspace()
    const r = verifyRun({ stop: 'end', workspace: dir, appended: resposta('A funcao capToolResult guarda o resultado numa variavel.') })
    expect(r.failures.map((f) => f.check)).toEqual(['fundamentacao'])
  })

  it('recusa citacao de arquivo que existe mas nao foi lido neste run', () => {
    const dir = workspace()
    const r = verifyRun({ stop: 'end', workspace: dir, appended: resposta('Definido em src/loop/runner.ts:10.', leu('README.md')) })
    expect(r.failures[0]?.reason).toBe('cita src/loop/runner.ts sem ter lido nem encontrado esse arquivo neste run')
  })

  it('recusa citacao de exemplo e resposta dizendo que nao achou', () => {
    const dir = workspace()
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta('Ela verifica o processo. [arquivo:linha]', leu('README.md')) }).failures[0]?.reason).toBe('usa citacao de exemplo, sem arquivo real')
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta('A porta padrao nao foi encontrada nos arquivos.', leu('README.md')) }).failures[0]?.reason).toBe('o modelo diz que nao encontrou a resposta')
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta('A funcao selectTools não está definida no código.', leu('README.md')) }).ok).toBe(false)
  })

  it('ignora endereco, versao e nome de biblioteca que parecem arquivo', () => {
    const dir = workspace()
    const r = verifyRun({ stop: 'end', workspace: dir, appended: resposta('O daemon escuta em 127.0.0.1:47311, roda em Node.js e usa o site github.com.', leu('README.md')) })
    expect(r.ok).toBe(true)
    expect(r.citations).toBe(0)
  })

  it('recusa resposta vazia, raciocinio vazado e run que nao terminou', () => {
    const dir = workspace()
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta('   ') }).failures[0]?.reason).toBe('resposta vazia')
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta("Okay, let's see. The user wants") }).failures[0]?.check).toBe('resposta')
    expect(verifyRun({ stop: 'max_steps', workspace: dir, appended: resposta('parcial') }).failures[0]?.reason).toBe('run terminou com max_steps')
  })

  it('recusa quando todas as ferramentas falharam, e aceita quando alguma funcionou', () => {
    const dir = workspace()
    const erro = (id: string): Message => ({ role: 'tool', parts: [{ type: 'tool_result', callId: id, content: 'arquivo nao encontrado', isError: true }] })
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta('pronto', [erro('a'), erro('b')]) }).ok).toBe(false)
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta('pronto', [erro('a'), ...leu('README.md')]) }).ok).toBe(true)
  })

  it('roda so as verificacoes pedidas', () => {
    const dir = workspace()
    expect(verifyRun({ stop: 'end', workspace: dir, appended: resposta('Veja inventado.ts:1') }, ['parada', 'resposta']).ok).toBe(true)
  })
})

describe('CascadeSchema', () => {
  it('vem com explicar e todas as verificacoes por padrao', () => {
    const c = CascadeSchema.parse({ agent: 'qwen3' })
    expect(c.intents).toEqual(['explicar'])
    expect(c.checks).toEqual(['parada', 'resposta', 'fundamentacao', 'citacoes', 'ferramentas'])
  })
})
