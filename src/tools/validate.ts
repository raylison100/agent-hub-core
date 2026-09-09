import { Ajv, type ValidateFunction } from 'ajv'
import type { ToolDefinition } from '../types.js'

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

const ajv = new Ajv({
  removeAdditional: 'all',
  useDefaults: true,
  coerceTypes: true,
  strict: false,
  allErrors: true,
})

const compiled = new WeakMap<ToolDefinition, ValidateFunction>()

/** Funil de validacao: parse, schema e remocao de campos desconhecidos. */
export function validateCall(def: ToolDefinition, rawArgs: unknown): ValidationResult {
  const parsed = parse(rawArgs)
  if (!parsed.ok) return parsed
  const validate = compile(def)
  if (validate(parsed.args)) return { ok: true, args: parsed.args }
  const detail = (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
    .join('; ')
  return { ok: false, error: `argumentos invalidos para ${def.name}: ${detail}` }
}

function parse(raw: unknown): ValidationResult {
  if (raw === undefined || raw === null) return { ok: false, error: 'argumentos nao sao JSON valido' }
  if (typeof raw === 'string') {
    try {
      return parse(JSON.parse(raw))
    } catch {
      return { ok: false, error: 'argumentos nao sao JSON valido' }
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'argumentos devem ser um objeto' }
  return { ok: true, args: { ...(raw as Record<string, unknown>) } }
}

function compile(def: ToolDefinition): ValidateFunction {
  const cached = compiled.get(def)
  if (cached) return cached
  const fn = ajv.compile(def.inputSchema)
  compiled.set(def, fn)
  return fn
}
