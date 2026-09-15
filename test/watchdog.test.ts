import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatibleAdapter } from '../src/providers/openai-compatible.js'
import { ProviderStalledError } from '../src/providers/watchdog.js'

let server: Server | undefined

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
  server = undefined
})

function sse(text: string): string {
  const chunk = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
}

async function listen(handler: (attempt: number, res: import('node:http').ServerResponse) => void): Promise<string> {
  let attempt = 0
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => handler(++attempt, res))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

const request = { system: 's', messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'oi' }] }], tools: [] }

describe('watchdog do provedor', () => {
  it('cancela a chamada muda e tenta de novo uma vez', async () => {
    const baseURL = await listen((attempt, res) => {
      if (attempt === 1) return
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse('pronto'))
    })
    const adapter = new OpenAICompatibleAdapter({ provider: 'gemini', model: 'm', apiKey: 'k', baseURL, idleTimeoutMs: 150 })
    const result = await adapter.chat(request as never)
    expect(result.message.parts).toEqual([{ type: 'text', text: 'pronto' }])
  })

  it('desiste depois da segunda chamada muda', async () => {
    const baseURL = await listen(() => undefined)
    const adapter = new OpenAICompatibleAdapter({ provider: 'gemini', model: 'm', apiKey: 'k', baseURL, idleTimeoutMs: 100 })
    await expect(adapter.chat(request as never)).rejects.toBeInstanceOf(ProviderStalledError)
  })
})
