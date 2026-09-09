import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAgentsRepo, parseProfile } from '../src/agents/load.js'
import { loadPlugin } from '../src/agents/plugins.js'
import { Budget } from '../src/cost/budget.js'
import { Ledger } from '../src/cost/ledger.js'
import { Pricing } from '../src/cost/pricing.js'
import { HookRunner, interpret } from '../src/hooks/runner.js'
import { AgentRunner, type RunEvent } from '../src/loop/runner.js'
import { nativeTools } from '../src/tools/native.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ChatResult, ProviderAdapter } from '../src/types.js'

const ctx = { sessionId: 's', runId: 'r', agent: 'teste', workspace: process.cwd() }

describe('HookRunner', () => {
  it('nega no formato proprio por codigo de saida e por JSON', async () => {
    const runner = new HookRunner([
      { event: 'tool.before', command: `node -e "process.exit(1)"`, match: { tool: 'run_command' }, timeout_ms: 5000, format: 'agent-hub' },
      { event: 'tool.before', command: `node -e "console.log(JSON.stringify({decision:'deny',reason:'proibido'}))"`, match: { tool: 'write_file' }, timeout_ms: 5000, format: 'agent-hub' },
    ])
    expect((await runner.before(ctx, 'run_command', {})).allow).toBe(false)
    expect((await runner.before(ctx, 'write_file', {})).reason).toBe('proibido')
    expect((await runner.before(ctx, 'read_file', {})).allow).toBe(true)
  })

  it('tool.after pode substituir o resultado', async () => {
    const runner = new HookRunner([
      { event: 'tool.after', command: `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify({output:'trocado:'+JSON.parse(d).tool})))"`, match: {}, timeout_ms: 5000, format: 'agent-hub' },
    ])
    expect(await runner.after(ctx, 'read_file', {}, 'original')).toBe('trocado:read_file')
  })

  it('interpreta o formato do Claude Code', () => {
    const hook = { event: 'tool.before' as const, command: '', match: {}, timeout_ms: 1, format: 'claude-code' as const }
    expect(interpret(hook, { code: 2, stdout: '', stderr: 'nao pode' })).toEqual({ allow: false, reason: 'nao pode' })
    expect(interpret(hook, { code: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"x"}}', stderr: '' }).allow).toBe(false)
    expect(interpret(hook, { code: 1, stdout: '', stderr: '' }).allow).toBe(true)
  })

  it('casa o nome de ferramenta traduzido no formato do Claude Code', async () => {
    const runner = new HookRunner([{ event: 'tool.before', command: `node -e "process.exit(2)"`, match: { tool: 'Bash' }, timeout_ms: 5000, format: 'claude-code' }])
    expect((await runner.before(ctx, 'run_command', { command: 'ls' })).allow).toBe(false)
    expect((await runner.before(ctx, 'read_file', {})).allow).toBe(true)
  })
})

function pluginFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-'))
  mkdirSync(join(dir, '.claude-plugin'))
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'Meu Plugin' }))
  mkdirSync(join(dir, 'skills', 'revisar'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'revisar', 'SKILL.md'), '---\nname: revisar\ndescription: revisa\n---\ncorpo da skill')
  mkdirSync(join(dir, 'commands'))
  writeFileSync(join(dir, 'commands', 'deploy.md'), '---\ndescription: faz deploy\n---\npassos do deploy')
  mkdirSync(join(dir, 'agents'))
  writeFileSync(join(dir, 'agents', 'revisor.md'), '---\nname: revisor\ndescription: revisa MR\ntools: Read, Grep, Bash\nmodel: sonnet\n---\nVoce revisa.')
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { gitlab: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/srv.js'], env: { TOKEN: '$GL' } } } }))
  mkdirSync(join(dir, 'hooks'))
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ok' }] }], SessionStart: [] } }))
  return dir
}

describe('loadPlugin', () => {
  it('traduz skills, comandos, agentes, MCP e hooks do layout do Claude Code', () => {
    const dir = pluginFixture()
    const bundle = loadPlugin(dir, { default: { provider: 'ollama', model: 'qwen3:14b', context: { window: 32768 } } })
    expect(bundle.name).toBe('meu-plugin')
    expect([...bundle.skills.keys()]).toEqual(['meu-plugin:revisar', 'meu-plugin:deploy'])
    const profile = bundle.profiles.get('meu-plugin-revisor')!
    expect(profile.provider).toBe('ollama')
    expect(profile.tools.native).toEqual(['read_file', 'search', 'run_command'])
    expect(profile.skills).toContain('meu-plugin:revisar')
    expect(bundle.mcp['meu-plugin-gitlab']?.args[0]).toBe(`${dir}/srv.js`)
    expect(bundle.hooks[0]).toMatchObject({ event: 'tool.before', format: 'claude-code', match: { tool: 'Bash' }, cwd: dir })
    expect(bundle.errors.some((e) => e.message.includes('SessionStart'))).toBe(true)
  })

  it('sem override, o agente do plugin vira erro e nao perfil', () => {
    const bundle = loadPlugin(pluginFixture(), {})
    expect(bundle.profiles.size).toBe(0)
    expect(bundle.errors.some((e) => e.message.includes('override'))).toBe(true)
  })

  it('loadAgentsRepo mescla plugins declarados em plugins.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-'))
    mkdirSync(join(root, 'profiles'))
    const plugin = pluginFixture()
    writeFileSync(join(root, 'plugins.json'), JSON.stringify({ plugins: [{ path: plugin }] }))
    writeFileSync(join(root, 'overrides.json'), JSON.stringify({ default: { provider: 'ollama', model: 'x', context: { window: 1000 } } }))
    const repo = loadAgentsRepo(root)
    expect(repo.profiles.has('meu-plugin-revisor')).toBe(true)
    expect(repo.mcp.servers['meu-plugin-gitlab']).toBeDefined()
    expect(repo.hooks).toHaveLength(1)
  })
})

describe('delegacao', () => {
  it('expoe a ferramenta delegate e soma o custo do filho', async () => {
    const profile = parseProfile(
      'p.md',
      '---\nname: pai\ndescription: pai\nprovider: ollama\nmodel: fake\ndelegates: [filho]\ncontext:\n  window: 1000\n---\nPrompt.',
    )
    const calls: ChatResult[] = [
      {
        message: { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'delegate', args: { agent: 'filho', task: 'leia tudo' } }] },
        toolCalls: [{ type: 'tool_call', id: 'c1', name: 'delegate', args: { agent: 'filho', task: 'leia tudo' } }],
        stopReason: 'tool',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false },
        model: 'fake',
        latencyMs: 1,
      },
    ]
    const seen: string[] = []
    const adapter: ProviderAdapter = {
      provider: 'ollama',
      model: 'fake',
      capabilities: () => ({ streaming: false, cacheControl: false, countTokens: false, reasoningLevels: false, historyEditable: true }),
      async chat(req) {
        seen.push(req.tools.map((t) => t.name).join(','))
        return (
          calls.shift() ?? {
            message: { role: 'assistant', parts: [{ type: 'text', text: 'fim' }] },
            toolCalls: [],
            stopReason: 'end',
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false },
            model: 'fake',
            latencyMs: 1,
          }
        )
      },
    }
    const ledger = new Ledger(new Database(':memory:'))
    const registry = new ToolRegistry()
    registry.registerAll(nativeTools())
    const events: RunEvent[] = []
    const runner = new AgentRunner({
      adapter,
      profile,
      tools: registry,
      skills: new Map(),
      policy: { read: 'allow', write: 'ask', exec: 'ask' },
      pricing: new Pricing({ version: 't', models: { 'ollama/*': { input: 0, output: 0, cache_read: 0, cache_write: 0 } } }),
      ledger,
      budget: new Budget(ledger, {}, { runId: 'r', sessionId: 's', agent: 'pai' }),
      workspace: process.cwd(),
      approve: async () => 'allow',
      emit: (e) => events.push(e),
      delegate: async (agent, task) => ({ text: `${agent} fez: ${task}`, costUsd: 0.25, runId: 'child', stop: 'end' }),
    })
    const result = await runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'x' })
    expect(seen[0]).toContain('delegate')
    expect(result.costUsd).toBeCloseTo(0.25)
    expect(events.filter((e) => e.type === 'delegation')).toHaveLength(2)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.content).toContain('filho fez: leia tudo')
  })
})
