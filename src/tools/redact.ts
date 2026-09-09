const inlineFlag = /^\(\?([a-z]+)\)/

/** Substitui trechos que casam com padroes de segredo por `[redacted]`. */
export class Redactor {
  private readonly patterns: RegExp[]

  constructor(patterns: string[]) {
    this.patterns = patterns.map(compile)
  }

  redact(text: string): string {
    let out = text
    for (const p of this.patterns) out = out.replace(p, '[redacted]')
    return out
  }

  get size(): number {
    return this.patterns.length
  }
}

function compile(source: string): RegExp {
  const m = inlineFlag.exec(source)
  const flags = new Set(['g'])
  let body = source
  if (m) {
    for (const f of m[1]!) flags.add(f)
    body = source.slice(m[0].length)
  }
  return new RegExp(body, [...flags].join(''))
}
