import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { Check, LogOut, UserCircle } from '@/lib/icons'
import { $keycloakAccount, refreshKeycloakAccount, signOutKeycloak } from '@/store/account'

import { ListRow, Pill, SectionHeading, SettingsContent, SettingsSkeleton } from './primitives'

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
  const [confirmOpen, setConfirmOpen] = useState(false)
  const copy = t.settings.account

  // Re-read on mount rather than trusting a boot-time snapshot: the main
  // process only learns the realm config once a backend has started, so an
  // early read reports "not configured" on a perfectly gated install.
  useEffect(() => {
    void refreshKeycloakAccount()
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
