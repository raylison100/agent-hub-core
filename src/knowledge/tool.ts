import type { RegisteredTool } from '../tools/registry.js'
import type { KnowledgeStore } from './store.js'

/** Ferramenta de busca na base de conhecimento do workspace. A saida vem com a citacao pronta para o agente copiar. */
export function knowledgeTool(store: KnowledgeStore): RegisteredTool {
  return {
    definition: {
      name: 'knowledge_search',
      description:
        'Busca na base de conhecimento do projeto (.agent-hub/knowledge): documentos, transcricoes e material que o usuario deixou ali. ' +
        'Toda afirmacao tirada daqui precisa vir com a citacao [arquivo:linha] que a busca devolve.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'palavras do que voce procura' },
          limit: { type: 'number', description: 'quantos trechos, padrao 5', default: 5 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async handler(args, ctx) {
      const limite = typeof args.limit === 'number' ? Math.max(1, Math.min(10, args.limit)) : 5
      const hits = store.search(ctx.workspace, String(args.query), limite)
      if (hits.length === 0) return 'nada encontrado na base de conhecimento deste workspace'
      return hits
        .map((h) => `[${h.file}:${h.firstLine}-${h.lastLine}]\n${h.text}`)
        .join('\n\n---\n\n')
        .concat('\n\nCite assim ao usar: [arquivo:linha].')
    },
  }
}
