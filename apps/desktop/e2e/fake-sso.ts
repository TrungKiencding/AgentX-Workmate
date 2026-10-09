/**
 * A local stand-in for AgentX SSO, for specs that sign in for real.
 *
 * One loopback HTTP server plays three parts:
 *
 *  - a Keycloak realm (`/realms/agentx/...`): discovery, an authorize endpoint
 *    that redirects straight back with a code (what a browser holding a live
 *    SSO session does), the token endpoint with PKCE, RS256 ID tokens and the
 *    JWKS the backend verifies them with;
 *  - the keys service (`/v1/...`): `POST /v1/model-key` answers like the real
 *    one — HTTP 424 `no_grantable_models` while the SSO console grants no model
 *    the proxy serves, a key once it does — plus the device heartbeat, and a
 *    404 license route (a service that predates licensing);
 *  - the model proxy the issued key points at (`/v1/models`).
 *
 * The spec flips the key answer and the person's display name between steps.
 * The desktop opens the authorize URL in a browser; specs route that through
 * `followSignInRedirects` instead, so no browser ever opens.
 */

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const FAKE_SSO_REALM = 'agentx'
export const FAKE_SSO_CLIENT_ID = 'agentx-workmate'

/** The SSO console refusal from the bug report, word for word. */
export const NO_GRANTABLE_MODELS_DETAIL =
  'None of the models chosen in the SSO console is served by the model proxy right now.'

export interface FakeSsoOptions {
  subject?: string
  name?: string
  email?: string
}

export interface FakeSso {
  url: string
  issuer: string
  subject: string
  /** `refuse`: the 424 above. `issue`: a key for `mock-model` on this proxy. */
  setKeys(mode: 'issue' | 'refuse'): void
  /** The `name` claim of the next ID token — what an administrator edits in the console. */
  setName(name: string): void
  /** How many times the keys service was asked for a model key. */
  keyRequests(): number
  close(): Promise<void>
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url')

export async function startFakeSso(options: FakeSsoOptions = {}): Promise<FakeSso> {
  const subject = options.subject ?? '6f1c2a9e-0b8d-4c55-9e1f-2d7a8b3c4e5f'
  const email = options.email ?? 'kien.test@astralx.com.vn'
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'fake-sso-1'
  const codes = new Map<string, { nonce?: string }>()
  const state = { keys: 'refuse' as 'issue' | 'refuse', name: options.name ?? 'Lê Trung Kiên' }
  let keyRequests = 0
  let url = ''

  const issuer = () => `${url}/realms/${FAKE_SSO_REALM}`

  const idToken = (nonce?: string) => {
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))

    const payload = b64url(
      JSON.stringify({
        aud: FAKE_SSO_CLIENT_ID,
        auth_time: now,
        azp: FAKE_SSO_CLIENT_ID,
        email,
        email_verified: true,
        exp: now + 1800,
        iat: now,
        iss: issuer(),
        name: state.name,
        preferred_username: 'kien.test',
        sub: subject,
        typ: 'ID',
        ...(nonce ? { nonce } : {})
      })
    )

    const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), privateKey)

    return `${header}.${payload}.${b64url(signature)}`
  }

  const tokens = (nonce?: string) => ({
    access_token: 'fake-access-token',
    expires_in: 1800,
    id_token: idToken(nonce),
    refresh_expires_in: 0,
    refresh_token: 'fake-refresh-token',
    scope: 'openid profile email offline_access',
    token_type: 'Bearer'
  })

  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status)
      res.end()

      return
    }

    const data = JSON.stringify(body)
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(data), 'Content-Type': 'application/json' })
    res.end(data)
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []

    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const parsed = new URL(req.url ?? '/', url)
      const path = parsed.pathname
      const realm = `/realms/${FAKE_SSO_REALM}`
      const body = Buffer.concat(chunks).toString('utf8')

      if (req.method === 'GET' && path === `${realm}/.well-known/openid-configuration`) {
        return send(res, 200, {
          authorization_endpoint: `${issuer()}/protocol/openid-connect/auth`,
          code_challenge_methods_supported: ['S256'],
          end_session_endpoint: `${issuer()}/protocol/openid-connect/logout`,
          id_token_signing_alg_values_supported: ['RS256'],
          issuer: issuer(),
          jwks_uri: `${issuer()}/protocol/openid-connect/certs`,
          response_types_supported: ['code'],
          revocation_endpoint: `${issuer()}/protocol/openid-connect/revoke`,
          token_endpoint: `${issuer()}/protocol/openid-connect/token`
        })
      }

      if (req.method === 'GET' && path === `${realm}/protocol/openid-connect/certs`) {
        return send(res, 200, { keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid, use: 'sig' }] })
      }

      if (req.method === 'GET' && path === `${realm}/protocol/openid-connect/auth`) {
        const code = crypto.randomUUID()
        const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '')

        codes.set(code, { nonce: parsed.searchParams.get('nonce') ?? undefined })
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('state', parsed.searchParams.get('state') ?? '')
        redirect.searchParams.set('iss', issuer())
        res.writeHead(302, { Location: redirect.toString() })
        res.end()

        return undefined
      }

      if (req.method === 'POST' && path === `${realm}/protocol/openid-connect/token`) {
        const form = new URLSearchParams(body)
        const grant = form.get('grant_type')

        if (grant === 'authorization_code') {
          const entry = codes.get(form.get('code') ?? '')

          codes.delete(form.get('code') ?? '')

          return entry && form.get('code_verifier')
            ? send(res, 200, tokens(entry.nonce))
            : send(res, 400, { error: 'invalid_grant' })
        }

        return grant === 'refresh_token'
          ? send(res, 200, tokens())
          : send(res, 400, { error: 'unsupported_grant_type' })
      }

      if (path === `${realm}/protocol/openid-connect/logout` || path === `${realm}/protocol/openid-connect/revoke`) {
        return send(res, 204)
      }

      if (req.method === 'POST' && path === '/v1/model-key') {
        keyRequests++

        return state.keys === 'refuse'
          ? send(res, 424, { detail: NO_GRANTABLE_MODELS_DETAIL, error: 'no_grantable_models' })
          : send(res, 200, {
              base_url: url,
              key: 'sk-fake-sso-0123456789abcdef',
              key_alias: `second-brain-kientest-${subject.slice(0, 8)}`,
              models: ['mock-model'],
              status: 'issued'
            })
      }

      if (req.method === 'POST' && path === '/v1/devices/heartbeat') {
        return send(res, 200, { status: 'ok' })
      }

      if (req.method === 'GET' && path === '/v1/license') {
        return send(res, 404, { detail: 'this service predates licensing', error: 'not_found' })
      }

      if (req.method === 'GET' && path === '/v1/models') {
        return send(res, 200, { data: [{ id: 'mock-model', object: 'model' }], object: 'list' })
      }

      return send(res, 404, { error: 'not_found' })
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    issuer: issuer(),
    keyRequests: () => keyRequests,
    setKeys: mode => {
      state.keys = mode
    },
    setName: name => {
      state.name = name
    },
    subject,
    url
  }
}
