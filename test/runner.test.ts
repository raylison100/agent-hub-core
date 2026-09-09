import Database from 'better-sqlite3'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProfile } from '../src/agents/load.js'
import { Budget } from '../src/cost/budget.js'
import { Ledger } from '../src/cost/ledger.js'
import { Pricing } from '../src/cost/pricing.js'
import { AgentRunner, type RunEvent } from '../src/loop/runner.js'
import { nativeTools } from '../src/tools/native.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ChatRequest, ChatResult, ProviderAdapter } from '../src/types.js'

const profile = parseProfile(
  'p.md',
  `---
name: teste
description: agente de teste
provider: ollama
model: fake
tools:
  native: [read_file, run_command]
policy: padrao
budget:
  run_usd: 1
context:
  window: 1000
repair_attempts: 1
---
Prompt.`,
)

const pricing = new Pricing({
  version: 't',
  models: { 'ollama/*': { input: 0, output: 0, cache_read: 0, cache_write: 0 }, 'caro/*': { input: 1_000_000, output: 1_000_000 } },
})

function fakeAdapter(script: Partial<ChatResult>[], provider: 'ollama' | 'caro' = 'ollama'): ProviderAdapter & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    provider: provider as never,
    model: 'fake',
    requests,
    capabilities: () => ({ streaming: false, cacheControl: false, countTokens: false, reasoningLevels: false }),
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] })
      const next = script.shift() ?? {}
      return {
        message: { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
        toolCalls: [],
        stopReason: 'end',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false },
        model: 'fake',
        latencyMs: 1,
        ...next,
      }
    },
  }
}

function harness(adapter: ProviderAdapter, workspace: string, policy = { read: 'allow', write: 'ask', exec: 'ask' } as const) {
  const ledger = new Ledger(new Database(':memory:'))
  const registry = new ToolRegistry()
  registry.registerAll(nativeTools())
  const events: RunEvent[] = []
  const approvals: string[] = []
  const runner = new AgentRunner({
    adapter,
    profile,
    tools: registry,
    skills: new Map(),
    policy,
    pricing,
    ledger,
    budget: new Budget(ledger, { runUsd: profile.budget.run_usd }, { runId: 'r', sessionId: 's', agent: 'teste' }),
    workspace,
    approve: async (call) => {
      approvals.push(call.name)
      return 'deny'
    },
    emit: (e) => events.push(e),
  })
  return { runner, ledger, events, approvals }
}

function workspaceWithFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-'))
  writeFileSync(join(dir, 'a.txt'), 'linha 1\nlinha 2\n')
  return dir
}

describe('AgentRunner', () => {
  it('executa ferramenta de leitura, registra no ledger e termina', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([
      {
        message: { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
        toolCalls: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
        stopReason: 'tool',
      },
    ])
    const h = harness(adapter, dir)
    const result = await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'leia a.txt' })
    expect(result.stop).toBe('end')
    expect(result.steps).toBe(2)
    const toolResult = h.events.find((e) => e.type === 'tool_result')
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.content).toContain('linha 2')
    expect(h.ledger.totals({ runId: 'r' }).calls).toBe(2)
    expect(adapter.requests[1]?.messages.at(-1)?.role).toBe('tool')
  })

  it('pede aprovacao para exec e devolve erro quando negado', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([
      {
        message: { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'run_command', args: { command: 'ls' } }] },
        toolCalls: [{ type: 'tool_call', id: 'c1', name: 'run_command', args: { command: 'ls' } }],
        stopReason: 'tool',
      },
    ])
    const h = harness(adapter, dir)
    await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'rode ls' })
    expect(h.approvals).toEqual(['run_command'])
    const parts = adapter.requests[1]?.messages.at(-1)?.parts ?? []
    expect(parts[0]?.type === 'tool_result' && parts[0].isError).toBe(true)
  })

  it('para com tool_call_invalid depois de esgotar reparos', async () => {
    const dir = workspaceWithFile()
    const bad = { type: 'tool_call' as const, id: 'c1', name: 'read_file', args: undefined, rawArgs: '{nope' }
    const adapter = fakeAdapter([
      { message: { role: 'assistant', parts: [bad] }, toolCalls: [bad], stopReason: 'tool' },
      { message: { role: 'assistant', parts: [bad] }, toolCalls: [bad], stopReason: 'tool' },
      { message: { role: 'assistant', parts: [bad] }, toolCalls: [bad], stopReason: 'tool' },
    ])
    const h = harness(adapter, dir)
    const result = await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'x' })
    expect(result.stop).toBe('tool_call_invalid')
    expect(result.steps).toBe(2)
  })

  it('para por orcamento antes de chamar um modelo caro', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([], 'caro')
    const h = harness(adapter, dir)
    const result = await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'x' })
    expect(result.stop).toBe('budget_exceeded')
    expect(adapter.requests).toHaveLength(0)
  })
})
