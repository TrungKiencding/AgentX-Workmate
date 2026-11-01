import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { $keycloakAccount, type KeycloakAccountState, refreshKeycloakAccount } from '@/store/account'
import { $gatewayState } from '@/store/session'

/**
 * Who is signed in, kept current for surfaces that show it at a glance (the
 * sidebar's account row, the home greeting).
 *
 * The main process only learns the realm config once a backend has started,
 * so a read at app launch can come back "not configured" on a perfectly
 * signed-in install — and a once-only read then left the name missing until
 * Settings → Account happened to read again. So the store is re-read every
 * time the gateway (re)opens while it still shows no one signed in: the
 * backend is up by then, and the answer is real. The read is local (the
 * token store on disk), so repeating it costs nothing.
 */
export function useKeycloakAccount(): KeycloakAccountState {
  const account = useStore($keycloakAccount)
  const gatewayState = useStore($gatewayState)

  useEffect(() => {
    if (!account.loaded || (gatewayState === 'open' && !account.signedIn)) {
      void refreshKeycloakAccount()
    }
  }, [account.loaded, account.signedIn, gatewayState])

  return account
}
