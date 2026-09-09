import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { parseProfile } from '../src/agents/load.js'
import { Budget } from '../src/cost/budget.js'
import { Ledger } from '../src/cost/ledger.js'
import { Pricing } from '../src/cost/pricing.js'
import { AgentRunner, type RunEvent } from '../src/loop/runner.js'
import { nativeTools } from '../src/tools/native.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ChatResult, ProviderAdapter } from '../src/types.js'

const profile = parseProfile(
  'p.md',
  `---
name: fases
description: teste de fases
provider: ollama
model: fake
tools:
  native: [read_file, edit_file, run_command]
context:
  window: 1000
phases:
  - name: entender
    tools: [read_file]
    until: { tool_called: plan }
  - name: executar
    tools: [edit_file, run_command]
    until: { tool_called: done }
---
Prompt.`,
)

function call(id: string, name: string, args: Record<string, unknown>): ChatResult {
  return {
    message: { role: 'assistant', parts: [{ type: 'tool_call', id, name, args }] },
    toolCalls: [{ type: 'tool_call', id, name, args }],
    stopReason: 'tool',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: false },
    model: 'fake',
    latencyMs: 1,
  }
}

describe('fases por perfil', () => {
  it('expoe apenas as ferramentas da fase e avanca pelo sinal', async () => {
    const script = [call('c1', 'plan', { summary: 'vou editar' }), call('c2', 'done', { summary: 'editei' })]
    const seen: string[][] = []
    const adapter: ProviderAdapter = {
      provider: 'ollama',
      model: 'fake',
      capabilities: () => ({ streaming: false, cacheControl: false, countTokens: false, reasoningLevels: false, historyEditable: true }),
      async chat(req) {
        seen.push(req.tools.map((t) => t.name))
        return script.shift()!
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
      policy: { read: 'allow', write: 'allow', exec: 'allow' },
      pricing: new Pricing({ version: 't', models: { 'ollama/*': { input: 0, output: 0, cache_read: 0, cache_write: 0 } } }),
      ledger,
      budget: new Budget(ledger, {}, { runId: 'r', sessionId: 's', agent: 'fases' }),
      workspace: process.cwd(),
      approve: async () => 'allow',
      emit: (e) => events.push(e),
    })
    const result = await runner.run({ runId: 'r', sessionId: 's', history: [], userText: 'x' })
    expect(seen[0]).toEqual(['plan', 'read_file'])
    expect(seen[1]).toEqual(['done', 'edit_file', 'run_command'])
    expect(result.stop).toBe('end')
    expect(result.steps).toBe(2)
    expect(events.filter((e) => e.type === 'phase').map((e) => (e.type === 'phase' ? e.name : ''))).toEqual(['entender', 'executar'])
  })
})
