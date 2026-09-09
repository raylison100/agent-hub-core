export interface SealedFrame {
  e: 1
  iv: string
  d: string
}

const info = 'agent-hub-e2e-v1'
const salt = 'agent-hub-relay'

/** Deriva a chave AES-GCM de ponta a ponta a partir do token de conta, que o relay nunca ve em claro. */
export async function deriveE2eKey(accountToken: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle
  const base = await subtle.importKey('raw', encode(accountToken), 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encode(salt), info: encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function seal(key: CryptoKey, frame: unknown): Promise<SealedFrame> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encode(JSON.stringify(frame)))
  return { e: 1, iv: toBase64(iv), d: toBase64(new Uint8Array(data)) }
}

export async function open<T>(key: CryptoKey, sealed: SealedFrame): Promise<T> {
  const data = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.d))
  return JSON.parse(decode(new Uint8Array(data))) as T
}

export function isSealed(value: unknown): value is SealedFrame {
  return typeof value === 'object' && value !== null && (value as SealedFrame).e === 1 && typeof (value as SealedFrame).d === 'string'
}

function encode(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(text)
  const copy = new Uint8Array(new ArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
