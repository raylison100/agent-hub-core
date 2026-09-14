import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

export class OutsideWorkspaceError extends Error {
  constructor(readonly path: string, readonly workspace: string) {
    super(`Caminho fora do workspace: ${path}`)
  }
}

/** Resolve um caminho dentro do workspace, recusando escapes por `..` ou link simbolico. */
export function resolveInside(workspace: string, p: string): string {
  const root = realpathSync(workspace)
  const expanded = p.startsWith('~/') ? p.slice(2) : p
  const candidate = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded)
  const real = realpathOfNearestExisting(candidate)
  if (real !== root && !real.startsWith(root + sep)) throw new OutsideWorkspaceError(p, workspace)
  return candidate
}

/** Resolve um caminho de leitura: dentro do workspace ou, por caminho absoluto, dentro de uma das pastas extras liberadas para leitura. */
export function resolveReadable(workspace: string, p: string, extraRoots: string[] = []): string {
  try {
    return resolveInside(workspace, p)
  } catch (err) {
    if (!(err instanceof OutsideWorkspaceError) || !isAbsolute(p)) throw err
    const real = realpathOfNearestExisting(resolve(p))
    for (const extra of extraRoots) {
      let root: string
      try {
        root = realpathSync(extra)
      } catch {
        continue
      }
      if (real === root || real.startsWith(root + sep)) return resolve(p)
    }
    throw err
  }
}

function realpathOfNearestExisting(p: string): string {
  let current = p
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return p
      tail.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}
