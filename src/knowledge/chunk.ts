export interface Chunk {
  text: string
  firstLine: number
  lastLine: number
}

const charsPorToken = 4

/**
 * Corta o texto em trechos que cabem no limite, quebrando em titulo de markdown e em linha em branco,
 * guardando a faixa de linhas para a resposta poder citar arquivo e linha.
 */
export function chunkText(raw: string, maxTokens = 700): Chunk[] {
  const limite = maxTokens * charsPorToken
  const linhas = raw.replace(/\r\n/g, '\n').split('\n')
  const chunks: Chunk[] = []
  let atual: string[] = []
  let inicio = 1

  const fechar = (fim: number): void => {
    const texto = atual.join('\n').trim()
    if (texto) chunks.push({ text: texto, firstLine: inicio, lastLine: fim })
    atual = []
  }

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i]!
    const titulo = /^#{1,6}\s/.test(linha)
    const tamanho = atual.join('\n').length
    if (atual.length > 0 && (titulo || tamanho + linha.length > limite)) {
      fechar(i)
      inicio = i + 1
    }
    if (atual.length === 0) inicio = i + 1
    atual.push(linha)
  }
  fechar(linhas.length)
  return chunks.filter((c) => c.text.length > 20)
}
