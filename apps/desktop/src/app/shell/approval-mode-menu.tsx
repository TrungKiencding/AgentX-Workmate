import { useStore } from '@nanostores/react'
import { useEffect, useMemo } from 'react'

import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { Zap, ZapFilled } from '@/lib/icons'
import {
  $approvalModes,
  type ApprovalMode,
  type ApprovalModeRequester,
  setApprovalModeForProfile,
  syncApprovalModeForProfile
} from '@/store/approval-mode'

export const APPROVAL_MODE_ORDER = ['manual', 'smart', 'off'] as const satisfies readonly ApprovalMode[]

/**
 * The three approval modes as a radio list — label plus one line on what it
 * means. One list for every surface that offers the choice (the status-bar
 * menu, the pill under the composer), so they cannot drift apart.
 */
export function ApprovalModeOptions({
  mode,
  onSelect
}: {
  mode: ApprovalMode
  onSelect: (mode: ApprovalMode) => void
}) {
  const { t } = useI18n()
  const copy = t.shell.approvalMode

  const labels: Record<ApprovalMode, string> = { manual: copy.manual, off: copy.off, smart: copy.smart }

  const descriptions: Record<ApprovalMode, string> = {
    manual: copy.manualDescription,
    off: copy.offDescription,
    smart: copy.smartDescription
  }

  return (
    <>
      <DropdownMenuLabel>{copy.title}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup onValueChange={value => onSelect(value as ApprovalMode)} value={mode}>
        {APPROVAL_MODE_ORDER.map(value => (
          <DropdownMenuRadioItem className="items-start gap-2" key={value} value={value}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-foreground">{labels[value]}</span>
              <span className="text-2xs leading-snug text-(--ui-text-tertiary)">{descriptions[value]}</span>
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}

export function useApprovalModeStatusbarItem(profile: string, requestGateway: ApprovalModeRequester): StatusbarItem {
  const { t } = useI18n()
  const copy = t.shell.approvalMode
  const modes = useStore($approvalModes)
  const mode = modes[profile.trim() || 'default'] ?? 'smart'

  const labels = useMemo<Record<ApprovalMode, string>>(
    () => ({ manual: copy.manual, smart: copy.smart, off: copy.off }),
    [copy.manual, copy.off, copy.smart]
  )

  useEffect(() => {
    void syncApprovalModeForProfile(requestGateway, profile).catch(() => undefined)
  }, [profile, requestGateway])

  return {
    className: mode === 'off' ? 'bg-(--chrome-action-hover) text-foreground' : undefined,
    icon: mode === 'off' ? <ZapFilled className="size-3.5" /> : <Zap className="size-3.5 opacity-70" />,
    id: 'approval-mode',
    label: labels[mode],
    menuAlign: 'end',
    menuClassName: 'w-72 p-1',
    menuContent: (
      <ApprovalModeOptions
        mode={mode}
        onSelect={value => {
          void setApprovalModeForProfile(requestGateway, profile, value).catch(() => undefined)
        }}
      />
    ),
    title: copy.ariaLabel(labels[mode]),
    variant: 'menu'
  }
}
