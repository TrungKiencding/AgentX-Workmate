/**
 * keycloak-login.ts
 *
 * The I/O shell around keycloak-oidc.ts: binds the loopback listener that
 * catches Keycloak's redirect, opens the system browser, redeems the one-time
 * code, and hands back the token set. The pure logic (URL building, discovery
 * validation, token-response normalization) lives next door and is unit-tested
 * on its own.
 *
 * Dependencies are INJECTED (openExternal, getJson, postForm, an http-server
 * factory, a clock) so the orchestration runs in tests without Electron, a real
 * socket, or a browser — the same shape as native-oauth-login.ts.
 *
 * Security posture:
 *   - the listener binds 127.0.0.1 on one of a few FIXED ports (they have to be
 *     pre-registered with Keycloak; see KEYCLOAK_CALLBACK_PORTS) and is torn
 *     down the moment the callback lands or the timeout fires;
 *   - `state` is verified before the code is redeemed (RFC 6749 §10.12);
 *   - the PKCE verifier never leaves this process until the token POST;
 *   - the browser only ever sees a "you can close this window" page — never a
 *     token, never the outcome.
 */

import http from 'node:http'

import {
  buildKeycloakAuthorizeUrl,
  buildKeycloakRefreshBody,
  buildKeycloakTokenBody,
  callbackRedirectUri,
  discoveryUrl,
  KEYCLOAK_CALLBACK_PORTS,
  KEYCLOAK_LOGIN_TIMEOUT_MS,
  type KeycloakEndpoints,
  type KeycloakOidcConfig,
  parseDiscovery,
  parseKeycloakTokenResponse
} from './keycloak-oidc'
import { generatePkcePair, generateState, type NativeTokenSet, parseLoopbackCallback } from './native-oauth'

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
  '<body style="font:15px system-ui;margin:3rem;text-align:center">' +
  '<h2>&#10003; Signed in to AgentX Workmate</h2>' +
  '<p>You can close this window and return to the app.</p>' +
  '<script>setTimeout(()=>window.close(),800)</script>'

export interface KeycloakLoginDeps {
  /** Open a URL in the user's system browser (shell.openExternal). */
  openExternal: (url: string) => Promise<void>
  /** GET a URL and resolve the parsed JSON body. */
  getJson: (url: string, opts?: { timeoutMs?: number }) => Promise<any>
  /** POST an application/x-www-form-urlencoded body, resolve parsed JSON. */
  postForm: (url: string, form: Record<string, string>, opts?: { timeoutMs?: number }) => Promise<any>
  /** http.createServer, injectable for tests. */
  createServer?: typeof http.createServer
  /** Unix seconds, injectable for tests. */
  now?: () => number
  timeoutMs?: number
  rememberLog?: (line: string) => void
}

/** Fetch and validate the realm's discovery document. */
export async function fetchKeycloakEndpoints(
  config: KeycloakOidcConfig,
  deps: Pick<KeycloakLoginDeps, 'getJson'>
): Promise<KeycloakEndpoints> {
  const body = await deps.getJson(discoveryUrl(config.issuer), { timeoutMs: 15_000 })

  return parseDiscovery(body, config.issuer)
}

/**
 * Listen on the first free port in KEYCLOAK_CALLBACK_PORTS.
 *
 * A busy port is not a failure — another Workmate window may be mid-login, or
 * an unrelated local process may hold it. Only exhausting the whole list is,
 * and it gets a message that names the ports so the user can find the culprit.
 */
function listenOnFirstFreePort(
  server: http.Server,
  ports: readonly number[],
  rememberLog: (line: string) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    let index = 0

    const attempt = () => {
      if (index >= ports.length) {
        reject(
          new Error(
            `AgentX sign-in needs one of the local ports ${ports.join(', ')} and they are all in use. ` +
              'Close whatever is using them (or any other AgentX Workmate sign-in already in progress) and try again.'
          )
        )

        return
      }

      const port = ports[index++]

      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('error', onError)

        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          rememberLog(`[keycloak] port ${port} unavailable (${err.code}); trying the next one`)
          attempt()

          return
        }

        reject(err instanceof Error ? err : new Error(String(err)))
      }

      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve(port)
      })
    }

    attempt()
  })
}

/**
 * Drive a full Keycloak sign-in and return the token set.
 *
 * Steps: discovery → bind a fixed loopback port → open the system browser at
 * Keycloak's authorize endpoint with our PKCE challenge → await the ?code=
 * redirect → verify state → POST the token endpoint with the verifier → return
 * tokens. Always tears the listener down.
 *
 * The code is single-use and Keycloak burns it on the first attempt, so a
 * failed exchange must restart the whole flow rather than retry the POST.
 */
export async function runKeycloakLogin(config: KeycloakOidcConfig, deps: KeycloakLoginDeps): Promise<NativeTokenSet> {
  const createServer = deps.createServer || http.createServer
  const timeoutMs = deps.timeoutMs ?? KEYCLOAK_LOGIN_TIMEOUT_MS
  const now = deps.now || (() => Math.floor(Date.now() / 1000))
  const log = deps.rememberLog || (() => undefined)

  const endpoints = await fetchKeycloakEndpoints(config, deps)

  const { verifier, challenge } = generatePkcePair()
  const state = generateState()
  const nonce = generateState()

  return new Promise<NativeTokenSet>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let redirectUri = ''

    const server = createServer((req, res) => {
      const url = req.url || '/'

      // Always answer with the close page: the browser learns nothing about
      // the outcome, and a favicon probe doesn't look like a failure.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(DONE_HTML)

      if (settled || !/[?&](code|error)=/.test(url)) {
        return
      }

      try {
        const { code } = parseLoopbackCallback(url, state)

        finishWith(async () => {
          const body = await deps.postForm(
            endpoints.tokenEndpoint,
            buildKeycloakTokenBody(config, { code, codeVerifier: verifier, redirectUri }),
            { timeoutMs: 15_000 }
          )

          return parseKeycloakTokenResponse(body, now())
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
      }

      try {
        server.close()
      } catch {
        // already closed
      }
    }

    const fail = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(error)
    }

    const finishWith = (produce: () => Promise<NativeTokenSet>) => {
      if (settled) {
        return
      }

      settled = true
      produce()
        .then(tokens => {
          cleanup()
          resolve(tokens)
        })
        .catch(error => {
          cleanup()
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    }

    listenOnFirstFreePort(server, KEYCLOAK_CALLBACK_PORTS, log)
      .then(port => {
        redirectUri = callbackRedirectUri(port)

        const authorizeUrl = buildKeycloakAuthorizeUrl(endpoints, config, {
          codeChallenge: challenge,
          state,
          redirectUri,
          nonce
        })

        timer = setTimeout(() => {
          fail(
            new Error('Sign-in timed out. The browser window may not have finished signing in to AgentX; try again.')
          )
        }, timeoutMs)

        log(`[keycloak] loopback listening on ${redirectUri}; opening system browser`)

        deps.openExternal(authorizeUrl).catch(error => {
          fail(
            new Error(
              `Could not open the system browser to sign in to AgentX: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          )
        })
      })
      .catch(error => fail(error instanceof Error ? error : new Error(String(error))))
  })
}

/**
 * Exchange a refresh token for a fresh set, straight at Keycloak.
 *
 * Throws on rejection so the caller can distinguish a dead session (clear it,
 * sign in again) from a network blip (keep what we have and retry) — the two
 * must not be conflated, or a flaky connection would sign the user out.
 */
export async function refreshKeycloakSession(
  config: KeycloakOidcConfig,
  refreshToken: string,
  deps: Pick<KeycloakLoginDeps, 'getJson' | 'postForm' | 'now'>
): Promise<NativeTokenSet> {
  if (!refreshToken) {
    throw new Error('No Keycloak refresh token stored')
  }

  const now = deps.now || (() => Math.floor(Date.now() / 1000))
  const endpoints = await fetchKeycloakEndpoints(config, deps)

  const body = await deps.postForm(endpoints.tokenEndpoint, buildKeycloakRefreshBody(config, refreshToken), {
    timeoutMs: 15_000
  })

  const next = parseKeycloakTokenResponse(body, now())

  // Keycloak rotates refresh tokens by default, but a realm can be configured
  // not to. Keep the old one rather than losing the ability to refresh at all.
  return next.refreshToken ? next : { ...next, refreshToken }
}

export { DONE_HTML }
