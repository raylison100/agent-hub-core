import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRepoRoot, nativeTools } from '../src/tools/native.js'
import { ToolRegistry } from '../src/tools/registry.js'

const registry = new ToolRegistry()
registry.registerAll(nativeTools())
const git = registry.get('git')!

function rodar(workspace: string): Promise<string> {
  return git.handler({ args: ['status', '--short'] }, { workspace, sessionId: 's', runId: 'r', agent: 'teste' })
}

describe('ferramenta git', () => {
  it('recusa pasta sem repositorio proprio em vez de subir para o repositorio de cima', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hub-sem-git-'))
    const saida = await rodar(dir)
    expect(saida).toContain('sem repositório git nesta pasta')
    expect(saida).not.toContain('exit_code')
  })

  it('roda normalmente na raiz de um repositorio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hub-com-git-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    expect(isRepoRoot(dir)).toBe(true)
    expect(await rodar(dir)).toContain('exit_code 0')
  })
})
