import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { Check, LogOut, UserCircle } from '@/lib/icons'
import {
  $accountIsolation,
  $keycloakAccount,
  type AccountIsolationState,
  refreshAccountIsolation,
  refreshKeycloakAccount,
  rotateAccountKey,
  signOutKeycloak
} from '@/store/account'

import { DeviceList } from './device-list'
import { ListRow, Pill, SectionHeading, SettingsContent, SettingsSkeleton } from './primitives'
import { SyncStatus } from './sync-status'

/**
 * One line describing the account's model key.
 *
 * Table-driven over the provisioning status rather than a condition ladder,
 * and it never renders the backend's raw `detail` for the states a user can
 * act on — those get product language. The remaining states fall through to
 * `detail`, which is operator-facing prose naming the setting that is wrong.
 */
export function describeKey(
  litellm: NonNullable<AccountIsolationState['litellm']>,
  copy: ReturnType<typeof useI18n>['t']['settings']['account']
): string {
  if (litellm.ok) {
    return litellm.masked_key ? `${litellm.masked_key} · ${litellm.base_url}` : litellm.base_url
  }

  const byStatus: Record<string, string> = {
    disabled: copy.keyDisabled,
    missing: copy.keyNone,
    offline: copy.keyOffline,
    // Not the same sentence as `disabled`, which they used to share. An
    // install with no model service configured is one somebody has to finish
    // setting up, and telling the user it "does not issue keys" reads as
    // settled policy rather than as a thing to chase.
    unconfigured: copy.keyUnconfigured,
    // The one status the user has to act on rather than wait out.
    revoked: copy.keyRevoked
  }

  return byStatus[litellm.status] || litellm.detail
}

/**
 * Settings → Account: who you are signed in to AgentX as, and how to leave.
 *
 * Everything shown here comes off the locally stored session, so the page
 * answers with no network — you can still see (and drop) your identity while
 * Keycloak is unreachable.
 */
export function AccountSettings() {
  const { t } = useI18n()
  const account = useStore($keycloakAccount)
  const isolation = useStore($accountIsolation)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [rotating, setRotating] = useState(false)
  const copy = t.settings.account

  // Re-read on mount rather than trusting a boot-time snapshot: the main
  // process only learns the realm config once a backend has started, so an
  // early read reports "not configured" on a perfectly gated install.
  useEffect(() => {
    void refreshKeycloakAccount()
    void refreshAccountIsolation()
  }, [])

  if (!account.loaded) {
    return <SettingsSkeleton sections={[{ heading: true, rows: 2 }]} />
  }

  // An install with no Keycloak client has no account to show. Say so plainly
  // instead of rendering an empty identity row that looks broken.
  if (!account.configured) {
    return (
      <SettingsContent>
        <SectionHeading icon={UserCircle} title={copy.title} />
        <EmptyState description={copy.notConfiguredDesc} title={copy.notConfiguredTitle} />
      </SettingsContent>
    )
  }

  // A session stored before the app carried identity claims has only the
  // subject id. Fall through rather than showing a blank name.
  const name = account.displayName || account.email || account.userId || copy.unknownUser

  return (
    <SettingsContent>
      <SectionHeading icon={UserCircle} title={copy.title} />

      <div className="grid gap-1">
        <ListRow
          // No pill when signed out — the title already says "Signed out", and
          // a badge repeating it puts the same word twice in one row.
          action={
            account.signedIn ? (
              <Pill tone="primary">
                <Check className="size-3" />
                {copy.signedIn}
              </Pill>
            ) : undefined
          }
          description={account.signedIn ? account.email || undefined : copy.signedOutDesc}
          // The subject id is the one value worth copying out of here (support
          // tickets, Keycloak admin lookups), so it opts out of the app-wide
          // user-select: none.
          hint={
            account.signedIn && account.userId ? (
              <span data-selectable-text="true">{account.userId}</span>
            ) : undefined
          }
          title={account.signedIn ? name : copy.signedOut}
        />

        <ListRow description={account.issuer || undefined} title={copy.realmTitle} />

        {account.signedIn && isolation.loaded && isolation.account ? (
          <ListRow
            // `isolated: false` means this backend is serving the machine's
            // SHARED home. Saying so is the whole point — a panel that showed
            // the account name regardless would imply a separation that is not
            // in place yet.
            action={
              isolation.isolated ? (
                <Pill tone="primary">
                  <Check className="size-3" />
                  {isolation.account}
                </Pill>
              ) : undefined
            }
            description={isolation.isolated ? isolation.home || undefined : copy.homeSharedDesc}
            hint={
              isolation.isolated && isolation.home ? (
                <span data-selectable-text="true">{isolation.account}</span>
              ) : undefined
            }
            title={copy.homeTitle}
          />
        ) : null}

        {account.signedIn && isolation.loaded && isolation.litellm ? (
          <ListRow
            action={
              // Rotation only makes sense once a key exists. Offering it against
              // a disabled or unconfigured install would be a button that
              // cannot succeed.
              isolation.litellm.ok ? (
                <Button
                  disabled={rotating}
                  onClick={async () => {
                    setRotating(true)

                    try {
                      await rotateAccountKey()
                    } finally {
                      setRotating(false)
                    }
                  }}
                  variant="outline"
                >
                  {rotating ? copy.keyRotating : copy.keyRotate}
                </Button>
              ) : undefined
            }
            description={describeKey(isolation.litellm, copy)}
            hint={
              isolation.litellm.models.length
                ? copy.keyModels(isolation.litellm.models.length)
                : undefined
            }
            title={copy.keyTitle}
          />
        ) : null}

        {account.signedIn ? (
          <ListRow
            action={
              <Button onClick={() => setConfirmOpen(true)} variant="outline">
                <LogOut />
                {copy.signOut}
              </Button>
            }
            description={copy.signOutDesc}
            title={copy.signOutTitle}
          />
        ) : null}
      </div>

      {/* Below the model-key row, because "which machines hold this key" only
          makes sense once you have been told there is a key. Renders nothing
          when no second-brain service is configured. */}
      {account.signedIn ? <DeviceList /> : null}

      {/* And below the devices, because "is my history in step" is a question
          about those machines. Renders nothing when synchronisation is not
          configured on this install. */}
      {account.signedIn ? <SyncStatus /> : null}

      <ConfirmDialog
        confirmLabel={copy.signOut}
        description={copy.signOutConfirmDesc}
        destructive
        // The reload takes over on success, so don't race it with a dismiss.
        dismissOnConfirm={false}
        onClose={() => setConfirmOpen(false)}
        onConfirm={signOutKeycloak}
        open={confirmOpen}
        title={copy.signOutConfirmTitle}
      />
    </SettingsContent>
  )
}
