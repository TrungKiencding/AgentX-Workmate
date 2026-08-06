/**
 * keycloak-session-store.ts
 *
 * Persistence for the desktop's Keycloak sign-in, layered on the existing
 * encrypted native-token store.
 *
 * The whole reason this file exists is the KEY. `persistNativeTokenSet` keys by
 * gateway base URL, which is right for a remote gateway and wrong for the local
 * one: the desktop spawns its backend with `--port 0`, so the base URL carries
 * an ephemeral port that is a different number every launch. Keying on it would
 * write a fresh entry each time and never find the previous one — the user
 * would be asked to sign in on every single app start, with an ever-growing
 * pile of orphaned entries behind them.
 *
 * Keying on issuer + clientId instead makes the session what it actually is:
 * one identity per Keycloak realm+client, shared across every profile, every
 * window, and every backend port the app happens to get.
 */

import { type KeycloakOidcConfig } from './keycloak-oidc'
import { type NativeTokenSet } from './native-oauth'
import { loadNativeTokenSet, type NativeTokenStoreIo, persistNativeTokenSet } from './native-token-store'

/**
 * The store key for a realm+client pair.
 *
 * Prefixed so it can never collide with the gateway-URL keys the brokered flow
 * writes into the same file.
 */
export function keycloakStorageKey(config: Pick<KeycloakOidcConfig, 'issuer' | 'clientId'>): string {
  return `keycloak:${config.issuer.replace(/\/+$/, '')}:${config.clientId}`
}

/** Load the stored session for this realm+client, or null. */
export function loadKeycloakSession(
  config: Pick<KeycloakOidcConfig, 'issuer' | 'clientId'>,
  io: NativeTokenStoreIo
): NativeTokenSet | null {
  return loadNativeTokenSet(keycloakStorageKey(config), io)
}

/** Persist (or, with `tokens === null`, forget) the session for this realm+client. */
export function persistKeycloakSession(
  config: Pick<KeycloakOidcConfig, 'issuer' | 'clientId'>,
  tokens: NativeTokenSet | null,
  io: NativeTokenStoreIo
): void {
  persistNativeTokenSet(keycloakStorageKey(config), tokens, io)
}
