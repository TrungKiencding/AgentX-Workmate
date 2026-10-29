import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'

import { SETTINGS_ROUTE } from '@/app/routes'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { ChevronDown, Keyboard, Settings, User } from '@/lib/icons'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'
import { $keycloakAccount, refreshKeycloakAccount } from '@/store/account'
import { $license } from '@/store/license'

/** Up to two initials from a display name, else the first letter of the email. */
export function accountInitials(displayName: string, email: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean)

  if (words.length > 0) {
    const first = words[0]![0] ?? ''
    const last = words.length > 1 ? (words.at(-1)![0] ?? '') : ''

    return `${first}${last}`.toLocaleUpperCase()
  }

  return (email.trim()[0] ?? '').toLocaleUpperCase()
}

/**
 * The account row pinned to the foot of the sidebar (Quiet Tool spec §5.3):
 * a 52px row under a divider — a 24px initials avatar on --bg-selected, the
 * name in primary ink · the plan in tertiary, and a ⌄. The whole row opens the
 * account menu. Renders nothing until someone is signed in: a row that says
 * "unknown" would be noise, and the sign-in gate already owns that state.
 */
export function SidebarAccountRow() {
  const account = useStore($keycloakAccount)
  const license = useStore($license)
  const navigate = useNavigate()
  const { t } = useI18n()
  const copy = t.sidebar.account
  const settingsHint = useKeybindHint('nav.settings')
  const shortcutsHint = useKeybindHint('keybinds.openPanel')

  useEffect(() => {
    if (!account.loaded) {
      void refreshKeycloakAccount()
    }
  }, [account.loaded])

  const name = account.displayName?.trim() || account.email?.trim() || ''

  if (!account.signedIn || !name) {
    return null
  }

  const plan = license.license?.plan?.name?.trim()
  const initials = accountInitials(account.displayName ?? '', account.email ?? '')

  return (
    <div className="shrink-0 border-t border-(--border-subtle) py-2" data-slot="sidebar-account">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={copy.menuLabel}
            className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-(--radius-control) px-3 text-left transition-colors duration-(--dur-micro) hover:bg-(--bg-hover) data-[state=open]:bg-(--bg-hover) [-webkit-app-region:no-drag]"
            type="button"
          >
            <span
              aria-hidden="true"
              className="grid size-6 shrink-0 place-items-center rounded-full bg-(--bg-selected) text-xs font-medium text-(--text-primary)"
            >
              {initials}
            </span>
            <span className="min-w-0 flex-1 truncate text-base">
              <span className="text-(--text-primary)">{name}</span>
              {plan ? <span className="text-(--text-tertiary)"> · {plan}</span> : null}
            </span>
            <ChevronDown className="size-4 shrink-0 text-(--icon-muted)" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)" side="top">
          {account.email ? <DropdownMenuLabel className="truncate">{account.email}</DropdownMenuLabel> : null}
          <DropdownMenuItem onSelect={() => navigate(`${SETTINGS_ROUTE}?tab=account`)}>
            <User />
            {copy.accountSettings}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate(SETTINGS_ROUTE)}>
            <Settings />
            {copy.settings}
            {settingsHint ? <DropdownMenuShortcut>{settingsHint}</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate(`${SETTINGS_ROUTE}?tab=keybinds`)}>
            <Keyboard />
            {copy.shortcuts}
            {shortcutsHint ? <DropdownMenuShortcut>{shortcutsHint}</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
