import { createHash, randomBytes } from 'node:crypto'

export interface OAuthConfig {
  authorization_url?: string
  token_url?: string
  client_id?: string
  client_secret?: string
  scopes?: string[]
  register_url?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** Par PKCE do RFC 7636: o verificador fica no daemon e so o desafio vai na URL de autorizacao. */
export function pkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** Le o cabecalho WWW-Authenticate de uma resposta 401 para achar onde estao os metadados do recurso protegido. */
export function resourceMetadataUrl(header: string | null | undefined): string | null {
  if (!header) return null
  const m = /resource_metadata="([^"]+)"/i.exec(header)
  return m ? m[1]! : null
}

/** Monta a URL de autorizacao com PKCE, estado e escopos. */
export function authorizationUrl(cfg: OAuthConfig, redirectUri: string, state: string, challenge: string): string {
  if (!cfg.authorization_url || !cfg.client_id) throw new Error('faltam authorization_url e client_id para autorizar')
  const url = new URL(cfg.authorization_url)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', cfg.client_id)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (cfg.scopes && cfg.scopes.length > 0) url.searchParams.set('scope', cfg.scopes.join(' '))
  return url.toString()
}

/** Troca o codigo pelo token, ou renova pelo refresh_token. Devolve o que guardar no cofre. */
export async function exchange(
  cfg: OAuthConfig,
  params: { code?: string; verifier?: string; refreshToken?: string; redirectUri?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  if (!cfg.token_url) throw new Error('falta token_url')
  const body = new URLSearchParams()
  if (params.refreshToken) {
    body.set('grant_type', 'refresh_token')
    body.set('refresh_token', params.refreshToken)
  } else {
    body.set('grant_type', 'authorization_code')
    body.set('code', params.code ?? '')
    body.set('code_verifier', params.verifier ?? '')
    if (params.redirectUri) body.set('redirect_uri', params.redirectUri)
  }
  if (cfg.client_id) body.set('client_id', cfg.client_id)
  if (cfg.client_secret) body.set('client_secret', cfg.client_secret)
  const res = await fetchImpl(cfg.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`token endpoint devolveu ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }
  if (!data.access_token) throw new Error('resposta sem access_token')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    scope: data.scope,
  }
}

/** Token vencido, ou a menos de um minuto de vencer, precisa de renovacao antes da proxima chamada. */
export function expired(tokens: OAuthTokens, agora = Date.now()): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - 60_000 <= agora
}

/** Descoberta do RFC 8414: metadados do servidor de autorizacao a partir da URL base. */
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OAuthConfig> {
  const base = issuer.replace(/\/+$/, '')
  const candidatos = [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`]
  for (const url of candidatos) {
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
      if (!res.ok) continue
      const data = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string }
      if (!data.authorization_endpoint || !data.token_endpoint) continue
      return { authorization_url: data.authorization_endpoint, token_url: data.token_endpoint, register_url: data.registration_endpoint }
    } catch {
      continue
    }
  }
  throw new Error(`não achei os metadados de OAuth em ${issuer}`)
}

/** Registro dinamico de cliente do RFC 7591, para servidor que nao exige cadastro manual. */
export async function registerClient(registerUrl: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<{ client_id: string; client_secret?: string }> {
  const res = await fetchImpl(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Agent Hub',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  if (!res.ok) throw new Error(`registro dinâmico devolveu ${res.status}`)
  const data = (await res.json()) as { client_id?: string; client_secret?: string }
  if (!data.client_id) throw new Error('registro dinâmico sem client_id')
  return { client_id: data.client_id, client_secret: data.client_secret }
}
