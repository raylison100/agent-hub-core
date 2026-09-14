import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandRoot, loadPlugin } from '../src/agents/plugins.js'
import { skillInstructions } from '../src/loop/runner.js'
import { nativeTools } from '../src/tools/native.js'
import { OutsideWorkspaceError, resolveReadable } from '../src/tools/workspace.js'

function plugin(): { base: string; dir: string; workspace: string } {
  const base = mkdtempSync(join(tmpdir(), 'agent-hub-plugin-'))
  const dir = join(base, 'meu-plugin')
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'skills/artes/assets'), { recursive: true })
  writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'meu-plugin' }))
  writeFileSync(join(dir, 'skills/artes/SKILL.md'), '---\nname: artes\ndescription: gera artes\n---\nLeia assets/modelo.html e rode node ${CLAUDE_SKILL_DIR}/scripts/x.mjs\n')
  writeFileSync(join(dir, 'skills/artes/assets/modelo.html'), '<h1>modelo</h1>\n')
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { imagem: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs'], env: { GEMINI_API_KEY: '${user_config.gemini_api_key}' } } } }),
  )
  const workspace = join(base, 'workspace')
  mkdirSync(workspace)
  return { base, dir, workspace }
}

describe('skills de plugin', () => {
  it('troca campo de configuracao do usuario pela variavel de ambiente em maiusculas', () => {
    expect(expandRoot('${user_config.gemini_api_key}', '/p')).toBe('${GEMINI_API_KEY}')
    const { dir } = plugin()
    const bundle = loadPlugin(dir, {})
    expect(bundle.mcp['meu-plugin-imagem']?.env.GEMINI_API_KEY).toBe('${GEMINI_API_KEY}')
    expect(bundle.mcp['meu-plugin-imagem']?.args[0]).toBe(`${dir}/mcp/server.mjs`)
  })

  it('marca a raiz do plugin na skill e indica as pastas nas instrucoes', () => {
    const { dir } = plugin()
    const skill = loadPlugin(dir, {}).skills.get('meu-plugin:artes')!
    expect(skill.root).toBe(dir)
    const texto = skillInstructions(skill)
    expect(texto).toContain(`Pasta desta skill: ${join(dir, 'skills/artes')}`)
    expect(texto).toContain(`node ${join(dir, 'skills/artes')}/scripts/x.mjs`)
  })

  it('le arquivo da pasta liberada pelo caminho absoluto e recusa o resto', async () => {
    const { base, dir, workspace } = plugin()
    const alvo = join(dir, 'skills/artes/assets/modelo.html')
    expect(resolveReadable(workspace, alvo, [dir])).toBe(alvo)
    expect(() => resolveReadable(workspace, alvo, [])).toThrow(OutsideWorkspaceError)
    expect(() => resolveReadable(workspace, join(dir, '..', 'workspace', '..', 'outro.txt'), [dir])).toThrow(OutsideWorkspaceError)
    writeFileSync(join(base, 'segredo.txt'), 'nao')
    expect(() => resolveReadable(workspace, `${dir}/../segredo.txt`, [dir])).toThrow(OutsideWorkspaceError)
    const read = nativeTools().find((t) => t.definition.name === 'read_file')!
    expect(await read.handler({ path: alvo }, { workspace, readRoots: [dir] })).toContain('<h1>modelo</h1>')
    await expect(read.handler({ path: alvo }, { workspace })).rejects.toThrow(OutsideWorkspaceError)
    const write = nativeTools().find((t) => t.definition.name === 'write_file')!
    await expect(write.handler({ path: join(dir, 'novo.txt'), content: 'x' }, { workspace, readRoots: [dir] })).rejects.toThrow(OutsideWorkspaceError)
  })
})
