import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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

export interface McpResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: { name: string; description?: string; required?: boolean }[]
}

export class McpBridge {
  private readonly servers = new Map<string, Connected>()

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Conecta a um servidor MCP por stdio ou HTTP e registra suas ferramentas com prefixo `servidor__`. */
  async connect(name: string, config: McpServerConfig, bearer?: string): Promise<RegisteredTool[]> {
    const existing = this.servers.get(name)
    if (existing) return existing.tools
    const transport = config.url
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: { ...resolveEnv(config.headers, this.env), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } },
        })
      : new StdioClientTransport({
          command: config.command!,
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

  /** Recursos expostos pelo servidor, para anexar a uma mensagem sob demanda. */
  async resources(name: string): Promise<McpResourceInfo[]> {
    const listed = (await this.client(name).listResources()) as { resources?: McpResourceInfo[] }
    return listed.resources ?? []
  }

  async readResource(name: string, uri: string): Promise<string> {
    const result = (await this.client(name).readResource({ uri })) as { contents?: { text?: string; blob?: string; mimeType?: string; uri: string }[] }
    return (result.contents ?? [])
      .map((c) => (typeof c.text === 'string' ? c.text : `[conteudo binario ${c.mimeType ?? ''} em ${c.uri}]`))
      .join('\n')
  }

  /** Prompts do servidor, expostos como atalhos `/servidor:prompt`. */
  async prompts(name: string): Promise<McpPromptInfo[]> {
    const listed = (await this.client(name).listPrompts()) as { prompts?: McpPromptInfo[] }
    return listed.prompts ?? []
  }

  async getPrompt(name: string, promptName: string, args: Record<string, string>): Promise<string> {
    const result = (await this.client(name).getPrompt({ name: promptName, arguments: args })) as {
      messages?: { role: string; content: { type?: string; text?: string } }[]
    }
    return (result.messages ?? [])
      .map((m) => (m.content.type === 'text' && typeof m.content.text === 'string' ? m.content.text : ''))
      .filter(Boolean)
      .join('\n\n')
  }

  private client(name: string): Client {
    const s = this.servers.get(name)
    if (!s) throw new Error(`servidor MCP nao conectado: ${name}`)
    return s.client
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
  for (const [k, v] of Object.entries(declared)) out[k] = expand(v, env)
  return out
}

function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{?([A-Z0-9_]+)\}?/g, (_, name: string) => {
    const resolved = env[name]
    if (resolved === undefined) throw new Error(`variavel ${name} nao definida para o MCP`)
    return resolved
  })
}

function filteredEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'LANG', 'SHELL', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA']
  const out: Record<string, string> = {}
  for (const k of keep) if (env[k]) out[k] = env[k]!
  return out
}
