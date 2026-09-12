import type { ChatRequest } from '../types.js'

/** Teto de saida pedido ao provedor: com raciocinio ligado, o pensamento ganha orcamento proprio e nao come o espaco da resposta. */
export function outputCap(req: ChatRequest, thinking: boolean): number {
  if (!thinking) return req.maxOutput
  return req.maxOutput + (req.reasoningBudget ?? 0)
}
