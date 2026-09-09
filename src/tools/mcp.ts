import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig } from '../agents/schema.js'
import type { JsonSchema } from '../types.js'
import { riskFor } from './policy.js'
import type { RegisteredTool } from './registry.js'

interface Connected {
  client: Client
  tools: RegisteredTool[]
}

interface McpToolInfo {
  name: string
  description?: string
  inputSchema: JsonSchema
}

interface McpCallResult {
  content?: unknown
  isError?: boolean
}

export class McpBridge {
  private readonly servers = new Map<string, Connected>()

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Sobe um servidor MCP por stdio e registra suas ferramentas com prefixo `servidor__`. */
  async connect(name: string, config: McpServerConfig): Promise<RegisteredTool[]> {
    const existing = this.servers.get(name)
    if (existing) return existing.tools
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...filteredEnv(this.env), ...resolveEnv(config.env, this.env) },
    })
    const client = new Client({ name: 'agent-hub', version: '0.1.0' })
    await client.connect(transport)
    const listed = (await client.listTools()) as { tools: McpToolInfo[] }
    const tools = listed.tools.map((t) => this.wrap(name, config, client, t))
    this.servers.set(name, { client, tools })
    return tools
  }

  async close(name?: string): Promise<void> {
    const names = name ? [name] : [...this.servers.keys()]
    for (const n of names) {
      const s = this.servers.get(n)
      if (!s) continue
      await s.client.close()
      this.servers.delete(n)
    }
  }

  connected(): string[] {
    return [...this.servers.keys()]
  }

  private wrap(server: string, config: McpServerConfig, client: Client, t: McpToolInfo): RegisteredTool {
    return {
      definition: {
        name: `${server}__${t.name}`,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        risk: riskFor(t.name, config.risk),
      },
      async handler(args) {
        const result = (await client.callTool({ name: t.name, arguments: args })) as McpCallResult
        const text = renderContent(result.content)
        if (result.isError) throw new Error(text || 'erro na ferramenta MCP')
        return text
      },
    }
  }
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content ?? '')
  return content
    .map((c: { type?: string; text?: string }) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n')
}

function resolveEnv(declared: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(declared)) {
    if (v.startsWith('$')) {
      const value = env[v.slice(1)]
      if (value === undefined) throw new Error(`variavel ${v.slice(1)} nao definida para o MCP`)
      out[k] = value
      continue
    }
    out[k] = v
  }
  return out
}

function filteredEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'LANG', 'SHELL', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA']
  const out: Record<string, string> = {}
  for (const k of keep) if (env[k]) out[k] = env[k]!
  return out
}
