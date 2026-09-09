import { describe, expect, it } from 'vitest'
import { deriveE2eKey, isSealed, open, seal } from '../src/protocol/e2e.js'
import { sandboxCommand } from '../src/tools/native.js'

describe('cifra ponta a ponta', () => {
  it('sela e abre um quadro com a mesma chave e falha com outra', async () => {
    const a = await deriveE2eKey('a'.repeat(64))
    const b = await deriveE2eKey('b'.repeat(64))
    const sealed = await seal(a, { type: 'auth', token: 'x' })
    expect(isSealed(sealed)).toBe(true)
    expect(JSON.stringify(sealed)).not.toContain('auth')
    expect(await open(a, sealed)).toEqual({ type: 'auth', token: 'x' })
    await expect(open(b, sealed)).rejects.toThrow()
  })
})

describe('sandbox por container', () => {
  it('monta docker run com workspace montado, sem rede e cwd relativo', () => {
    const cmd = sandboxCommand({ image: 'node:22', network: false, memory: '1g' }, '/home/u/proj', '/home/u/proj/api', 'npm test', 60000)
    expect(cmd).toContain('docker run --rm -i --network none')
    expect(cmd).toContain("--memory '1g'")
    expect(cmd).toContain("-v '/home/u/proj':/workspace")
    expect(cmd).toContain("-w '/workspace/api'")
    expect(cmd).toContain("'node:22' sh -lc 'npm test'")
  })
})
