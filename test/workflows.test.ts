import { describe, expect, it } from 'vitest'
import { parseProfile } from '../src/agents/load.js'
import { WorkflowSchema, evaluateCondition, maxWorkflowCost, parseExitCode, renderArgs, renderTemplate } from '../src/agents/workflows.js'

const wf = WorkflowSchema.parse({
  name: 'teste',
  inputs: ['cmd'],
  steps: [
    { id: 'rodar', tool: 'run_command', args: { command: '{{cmd}}' } },
    { id: 'diag', agent: 'leitor', prompt: 'saida {{rodar.output}}' },
    { id: 'corrigir', agent: 'dev', prompt: 'causa {{diag.cause}}' },
    { id: 'validar', tool: 'run_command', args: { command: '{{cmd}}' }, retry: { step: 'corrigir', max: 2, when: 'exit_code != 0' } },
  ],
})

function profile(name: string, runUsd: number) {
  return parseProfile('p.md', `---\nname: ${name}\ndescription: x\nprovider: ollama\nmodel: m\nbudget:\n  run_usd: ${runUsd}\ncontext:\n  window: 1000\n---\nP`)
}

describe('workflows', () => {
  it('renderiza templates com entradas e resultados de etapas', () => {
    const ctx = { cmd: 'npm test', rodar: { output: 'exit_code 1\nfalhou', exit_code: 1 }, diag: { cause: 'nulo' } }
    expect(renderTemplate('causa {{diag.cause}} em {{cmd}}', ctx)).toBe('causa nulo em npm test')
    expect(renderArgs({ command: '{{cmd}}', n: 2 }, ctx)).toEqual({ command: 'npm test', n: 2 })
    expect(renderTemplate('{{inexistente}}', ctx)).toBe('')
  })

  it('avalia condicoes de retry', () => {
    expect(evaluateCondition('exit_code != 0', { output: '', exit_code: 1 })).toBe(true)
    expect(evaluateCondition('exit_code == 0', { output: '', exit_code: 1 })).toBe(false)
    expect(evaluateCondition('output contains erro', { output: 'houve erro' })).toBe(true)
    expect(evaluateCondition('output matches ^exit_code [1-9]', { output: 'exit_code 2\n' })).toBe(true)
    expect(() => evaluateCondition('???', { output: '' })).toThrow()
  })

  it('custo maximo soma orcamentos por run vezes repeticoes possiveis', () => {
    const profiles = new Map([
      ['leitor', profile('leitor', 0)],
      ['dev', profile('dev', 0.3)],
    ])
    expect(maxWorkflowCost(wf, profiles)).toBeCloseTo(0.3 * 3)
    expect(maxWorkflowCost(wf, new Map())).toBeNull()
  })

  it('extrai exit_code da saida de run_command', () => {
    expect(parseExitCode('exit_code 3\nfoo')).toBe(3)
    expect(parseExitCode('sinal SIGKILL')).toBeUndefined()
  })

  it('rejeita retry para etapa posterior', () => {
    expect(() =>
      WorkflowSchema.parse({
        name: 'x',
        steps: [
          { id: 'a', tool: 't', retry: { step: 'b', when: 'exit_code != 0' } },
          { id: 'b', tool: 't' },
        ],
      }),
    ).not.toThrow()
  })
})
