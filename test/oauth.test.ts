import { describe, expect, it } from 'vitest'
import { authorizationUrl, discover, exchange, expired, pkce, registerClient, resourceMetadataUrl } from '../src/tools/oauth.js'

function respostaJson(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) } as Response
}

describe('pkce', () => {
  it('gera verificador e desafio diferentes a cada chamada', () => {
    const a = pkce()
    const b = pkce()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(a.verifier)
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('authorizationUrl', () => {
  it('monta a URL com pkce, estado e escopos', () => {
    const url = new URL(
      authorizationUrl({ authorization_url: 'https://auth.exemplo/authorize', client_id: 'abc', scopes: ['read', 'write'] }, 'http://127.0.0.1:47311/oauth/callback', 'estado1', 'desafio1'),
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('read write')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:47311/oauth/callback')
  })

  it('recusa quando falta client_id', () => {
    expect(() => authorizationUrl({ authorization_url: 'https://a/x' }, 'http://x', 's', 'c')).toThrow('client_id')
  })
})

describe('exchange', () => {
  it('troca o codigo pelo token e calcula o vencimento', async () => {
    let corpo = ''
    const tokens = await exchange({ token_url: 'https://auth.exemplo/token', client_id: 'abc' }, { code: 'c1', verifier: 'v1', redirectUri: 'http://x' }, (async (_url: string, init: RequestInit) => {
      corpo = String(init.body)
      return respostaJson({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 })
    }) as unknown as typeof fetch)
    expect(corpo).toContain('grant_type=authorization_code')
    expect(corpo).toContain('code_verifier=v1')
    expect(tokens.accessToken).toBe('tok')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
  })

  it('renova pelo refresh_token', async () => {
    let corpo = ''
    await exchange({ token_url: 'https://auth.exemplo/token' }, { refreshToken: 'ref' }, (async (_url: string, init: RequestInit) => {
      corpo = String(init.body)
      return respostaJson({ access_token: 'novo' })
    }) as unknown as typeof fetch)
    expect(corpo).toContain('grant_type=refresh_token')
  })

  it('explica quando o provedor recusa', async () => {
    await expect(
      exchange({ token_url: 'https://auth.exemplo/token' }, { code: 'x' }, (async () => respostaJson({ error: 'invalid_grant' }, false)) as unknown as typeof fetch),
    ).rejects.toThrow('token endpoint devolveu 400')
  })
})

describe('expired', () => {
  it('considera vencido o token que vence em menos de um minuto', () => {
    expect(expired({ accessToken: 't', expiresAt: Date.now() + 30_000 })).toBe(true)
    expect(expired({ accessToken: 't', expiresAt: Date.now() + 300_000 })).toBe(false)
    expect(expired({ accessToken: 't' })).toBe(false)
  })
})

describe('descoberta', () => {
  it('le os metadados do servidor de autorizacao', async () => {
    const cfg = await discover('https://auth.exemplo', (async (url: string) =>
      url.endsWith('/.well-known/oauth-authorization-server')
        ? respostaJson({ authorization_endpoint: 'https://auth.exemplo/authorize', token_endpoint: 'https://auth.exemplo/token' })
        : respostaJson({}, false)) as unknown as typeof fetch)
    expect(cfg.token_url).toBe('https://auth.exemplo/token')
  })

  it('avisa quando nao acha os metadados', async () => {
    await expect(discover('https://auth.exemplo', (async () => respostaJson({}, false)) as unknown as typeof fetch)).rejects.toThrow('nao achei os metadados')
  })

  it('le o resource_metadata do cabecalho de 401', () => {
    expect(resourceMetadataUrl('Bearer resource_metadata="https://api.exemplo/.well-known/oauth-protected-resource"')).toBe(
      'https://api.exemplo/.well-known/oauth-protected-resource',
    )
    expect(resourceMetadataUrl('Bearer realm="x"')).toBeNull()
  })

  it('registra cliente dinamicamente', async () => {
    const registrado = await registerClient('https://auth.exemplo/register', 'http://127.0.0.1:47311/oauth/callback', (async () =>
      respostaJson({ client_id: 'gerado' })) as unknown as typeof fetch)
    expect(registrado.client_id).toBe('gerado')
  })
})
