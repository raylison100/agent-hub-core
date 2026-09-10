import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'tmp-fake', version: '0.1.0' })

server.registerTool('get_data', { description: 'Le um dado', inputSchema: { id: z.string() } }, async ({ id }) => ({ content: [{ type: 'text', text: `dado ${id} (token ${process.env.FAKE_TOKEN ?? 'sem-token'})` }] }))

server.registerTool(
  'write_data',
  { description: 'Escreve um dado', inputSchema: { id: z.string() } },
  async ({ id }) => ({ content: [{ type: 'text', text: `escrito ${id}` }] }),
)

server.registerResource('doc', 'fake://doc', { description: 'doc de exemplo' }, async (uri) => ({ contents: [{ uri: uri.href, text: 'conteudo do recurso' }] }))

server.registerPrompt('revisar', { description: 'Prompt de revisao', argsSchema: { alvo: z.string() } }, ({ alvo }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `revise ${alvo}` } }],
}))

await server.connect(new StdioServerTransport())
