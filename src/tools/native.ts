import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, matchesGlob, relative } from 'node:path'
import type { RegisteredTool, ToolContext } from './registry.js'
import { resolveInside } from './workspace.js'

const outputLimit = 50 * 1024
const defaultTimeoutMs = 120_000
const maxTimeoutMs = 600_000
const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'vendor', '.next', 'build', 'target'])
const gitAllowed = new Set(['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout', 'switch', 'stash', 'show'])

export function nativeTools(): RegisteredTool[] {
  return [listDir, readFile, search, writeFile, editFile, runCommand, git]
}

const listDir: RegisteredTool = {
  definition: {
    name: 'list_dir',
    description: 'Lista arquivos e pastas de um diretorio do workspace.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Caminho relativo ao workspace. Padrao: raiz.' } },
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const dir = resolveInside(ctx.workspace, str(args.path) ?? '.')
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return entries.join('\n') || '(vazio)'
  },
}

const readFile: RegisteredTool = {
  definition: {
    name: 'read_file',
    description: 'Le um arquivo de texto do workspace, com faixa de linhas opcional.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const file = resolveInside(ctx.workspace, str(args.path)!)
    const lines = readFileSync(file, 'utf8').split('\n')
    const start = num(args.start_line) ?? 1
    const end = Math.min(num(args.end_line) ?? lines.length, lines.length)
    return lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}\t${l}`)
      .join('\n')
  },
}

const search: RegisteredTool = {
  definition: {
    name: 'search',
    description: 'Busca uma expressao regular em arquivos do workspace. Devolve arquivo, linha e trecho.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Diretorio inicial. Padrao: raiz.' },
        glob: { type: 'string', description: 'Filtro de nome, ex: *.php' },
        max_results: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const root = resolveInside(ctx.workspace, str(args.path) ?? '.')
    const regex = new RegExp(str(args.pattern)!, 'i')
    const glob = str(args.glob)
    const limit = num(args.max_results) ?? 100
    const hits: string[] = []
    walk(root, (file) => {
      if (hits.length >= limit) return false
      if (glob && !matchesGlob(file.split(/[\\/]/).pop()!, glob)) return true
      const lines = safeRead(file)?.split('\n') ?? []
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (regex.test(lines[i]!)) hits.push(`${relative(ctx.workspace, file)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`)
      }
      return true
    })
    return hits.join('\n') || '(nenhum resultado)'
  },
}

const writeFile: RegisteredTool = {
  definition: {
    name: 'write_file',
    description: 'Cria ou substitui um arquivo inteiro no workspace.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const file = resolveInside(ctx.workspace, str(args.path)!)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, str(args.content)!, 'utf8')
    return `gravado ${relative(ctx.workspace, file)}`
  },
}

const editFile: RegisteredTool = {
  definition: {
    name: 'edit_file',
    description: 'Substitui um trecho exato de um arquivo por outro. O trecho antigo precisa ocorrer uma unica vez.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const file = resolveInside(ctx.workspace, str(args.path)!)
    const content = readFileSync(file, 'utf8')
    const oldText = str(args.old_text)!
    const first = content.indexOf(oldText)
    if (first === -1) throw new Error('trecho antigo nao encontrado')
    if (content.indexOf(oldText, first + 1) !== -1) throw new Error('trecho antigo ocorre mais de uma vez')
    writeFileSync(file, content.slice(0, first) + str(args.new_text)! + content.slice(first + oldText.length), 'utf8')
    return `editado ${relative(ctx.workspace, file)}`
  },
}

const runCommand: RegisteredTool = {
  definition: {
    name: 'run_command',
    description: 'Executa um comando de shell dentro do workspace e devolve saida e codigo de saida.',
    risk: 'exec',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Subdiretorio do workspace. Padrao: raiz.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: maxTimeoutMs, default: defaultTimeoutMs },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const cwd = resolveInside(ctx.workspace, str(args.cwd) ?? '.')
    const timeout = num(args.timeout_ms) ?? defaultTimeoutMs
    if (ctx.sandbox) return runShell(sandboxCommand(ctx.sandbox, ctx.workspace, cwd, str(args.command)!, timeout), ctx.workspace, timeout + 5000, ctx)
    return runShell(str(args.command)!, cwd, timeout, ctx)
  },
}

/** Monta o `docker run` que executa o comando dentro do container com o workspace montado. */
export function sandboxCommand(sandbox: { image: string; network: boolean; memory?: string; cpus?: number }, workspace: string, cwd: string, command: string, timeoutMs: number): string {
  const rel = relative(workspace, cwd).replace(/\\/g, '/')
  const workdir = rel ? `/workspace/${rel}` : '/workspace'
  const parts = [
    'docker run --rm -i',
    sandbox.network ? '' : '--network none',
    sandbox.memory ? `--memory ${shellQuote(sandbox.memory)}` : '',
    sandbox.cpus ? `--cpus ${sandbox.cpus}` : '',
    `--stop-timeout ${Math.ceil(timeoutMs / 1000)}`,
    `-v ${shellQuote(workspace)}:/workspace`,
    `-w ${shellQuote(workdir)}`,
    shellQuote(sandbox.image),
    'sh -lc',
    shellQuote(command),
  ]
  return parts.filter(Boolean).join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const git: RegisteredTool = {
  definition: {
    name: 'git',
    description: `Executa um subcomando git restrito no workspace. Permitidos: ${[...gitAllowed].join(', ')}.`,
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['args'],
      additionalProperties: false,
    },
  },
  async handler(args, ctx) {
    const list = (args.args as string[]).map(String)
    const sub = list[0]!
    if (!gitAllowed.has(sub)) throw new Error(`subcomando git nao permitido: ${sub}`)
    if (sub === 'checkout' && list[1] !== '-b') throw new Error('checkout permitido apenas com -b para branch nova')
    if (list.some((a) => a === '--force' || a === '-f')) throw new Error('flags de forca nao permitidas')
    const quoted = list.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
    return runShell(`git ${quoted}`, resolveInside(ctx.workspace, '.'), defaultTimeoutMs, ctx)
  },
}

function runShell(command: string, cwd: string, timeoutMs: number, ctx: ToolContext): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd, env: process.env })
    const chunks: Buffer[] = []
    let size = 0
    const collect = (b: Buffer) => {
      if (size < outputLimit) chunks.push(b)
      size += b.length
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.min(timeoutMs, maxTimeoutMs))
    ctx.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let output = Buffer.concat(chunks).toString('utf8').slice(0, outputLimit)
      if (size > outputLimit) output += `\n[saida truncada em ${outputLimit} bytes de ${size}]`
      const exit = signal ? `sinal ${signal}` : `exit_code ${code ?? 0}`
      resolve(`${exit}\n${output}`)
    })
  })
}

function walk(dir: string, visit: (file: string) => boolean): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue
      if (!walk(full, visit)) return false
      continue
    }
    if (entry.isFile() && statSync(full).size < 2 * 1024 * 1024 && !visit(full)) return false
  }
  return true
}

function safeRead(file: string): string | null {
  try {
    const buf = readFileSync(file)
    if (buf.subarray(0, 512).includes(0)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}
