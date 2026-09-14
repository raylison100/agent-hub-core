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
import { outputCap } from '../src/providers/index.js'
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

  it('depois de compactar nao duplica a resposta nem regrava o historico', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([
      {
        message: { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }] },
        toolCalls: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
        stopReason: 'tool',
      },
    ])
    adapter.capabilities = () => ({ streaming: false, cacheControl: false, countTokens: false, reasoningLevels: false, historyEditable: true })
    const h = harness(adapter, dir)
    const history = [
      { role: 'user' as const, parts: [{ type: 'text' as const, text: 'antes' }] },
      { role: 'assistant' as const, parts: [{ type: 'tool_call' as const, id: 'c0', name: 'read_file', args: { path: 'a.txt' } }] },
      { role: 'tool' as const, parts: [{ type: 'tool_result' as const, callId: 'c0', content: 'x'.repeat(8000), isError: false }] },
    ]
    const result = await h.runner.run({ runId: 'r', sessionId: 's', history, userText: 'leia de novo' })
    expect(h.events.some((e) => e.type === 'compaction')).toBe(true)
    expect(result.stop).toBe('end')
    expect(result.appended.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const ids = adapter.requests[1]!.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_call' ? [p.id] : [])))
    expect(ids).toEqual(['c0', 'c1'])
  })

  it('tira do historico chamada e resultado repetidos antes de mandar ao provedor', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([])
    const h = harness(adapter, dir)
    const chamada = { role: 'assistant' as const, parts: [{ type: 'tool_call' as const, id: 'c9', name: 'read_file', args: { path: 'a.txt' } }] }
    const resposta = { role: 'tool' as const, parts: [{ type: 'tool_result' as const, callId: 'c9', content: 'linha', isError: false }] }
    await h.runner.run({ runId: 'r', sessionId: 's', history: [{ role: 'user', parts: [{ type: 'text', text: 'oi' }] }, chamada, chamada, resposta, resposta], userText: 'segue' })
    expect(adapter.requests[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
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

describe('teto de saida com raciocinio', () => {
  const vazio = {
    message: { role: 'assistant' as const, parts: [{ type: 'text' as const, text: '' }] },
    toolCalls: [],
    stopReason: 'max_output' as const,
    usage: { input: 135, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 8000, missing: false },
  }

  it('repete uma vez com teto maior e esforco menor quando o raciocinio come a saida', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([vazio])
    const h = harness(adapter, dir)
    const result = await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'crie um projeto novo' })
    expect(result.stop).toBe('end')
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.maxOutput).toBe(8000)
    expect(adapter.requests[0]?.reasoning).toBe('medium')
    expect(adapter.requests[1]?.maxOutput).toBe(16000)
    expect(adapter.requests[1]?.reasoning).toBe('low')
    expect(adapter.requests[1]?.messages.at(-1)?.role).toBe('user')
    expect(result.appended.some((m) => m.role === 'assistant' && m.parts.every((p) => p.type === 'text' && p.text === ''))).toBe(false)
    const aviso = h.events.find((e) => e.type === 'max_output_retry')
    expect(aviso && aviso.type === 'max_output_retry' && aviso.reasoningTokens).toBe(8000)
  })

  it('repete so uma vez e encerra em max_output se estourar de novo', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([vazio, vazio])
    const h = harness(adapter, dir)
    const result = await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'crie um projeto novo' })
    expect(result.stop).toBe('max_output')
    expect(adapter.requests).toHaveLength(2)
    expect(h.events.filter((e) => e.type === 'max_output_retry')).toHaveLength(1)
  })

  it('nao repete quando o passo estourou o teto mas escreveu texto', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([{ ...vazio, message: { role: 'assistant', parts: [{ type: 'text', text: 'resposta cortada' }] } }])
    const h = harness(adapter, dir)
    const result = await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'x' })
    expect(result.stop).toBe('max_output')
    expect(adapter.requests).toHaveLength(1)
  })

  it('manda o orcamento de raciocinio declarado no perfil junto do teto', async () => {
    const dir = workspaceWithFile()
    const adapter = fakeAdapter([])
    const h = harness(adapter, dir)
    await h.runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'x' })
    expect(adapter.requests[0]?.reasoningBudget).toBe(0)
  })
})

describe('outputCap', () => {
  const base = { system: '', messages: [], tools: [], maxOutput: 16000, reasoningBudget: 16000, reasoning: 'medium' as const, systemCacheTtl: '5m' as const, providerOptions: {} }

  it('soma o orcamento de raciocinio quando o modelo pensa', () => {
    expect(outputCap(base, true)).toBe(32000)
  })

  it('mantem o teto do perfil quando o raciocinio esta desligado', () => {
    expect(outputCap(base, false)).toBe(16000)
  })

  it('sem orcamento declarado, o teto nao muda', () => {
    expect(outputCap({ ...base, reasoningBudget: undefined }, true)).toBe(16000)
  })
})
