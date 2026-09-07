import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { StatusPill } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { compactNumber } from '@/lib/format'
import type { ToolsetInfo } from '@/types/hermes'

import { ToolChip } from '../master-detail'
import { SETTINGS_ROUTE } from '../routes'
import { ComputerUsePanel } from '../settings/computer-use-panel'
import { toolNames } from '../settings/helpers'
import { TerminalBackendPanel } from '../settings/terminal-backend-panel'
import { ToolsetConfigPanel } from '../settings/toolset-config-panel'

import { toolsetCopy } from './skills-data'
import { TechnicalDetailRow, TechnicalDetails } from './technical-details'

// One tool's whole setup surface, opened from its card: which service it
// runs through and the keys that service needs (`ToolsetConfigPanel`), the
// machine-side checks a few tools carry (computer control's permissions, the
// terminal's execution backend, vision's model link), then the technical
// tail — the internal name and every function the tool exposes, with how
// often each was called. The switch sits in the footer so a person who came
// to read can also decide.
export function ToolsetDetailDialog({
  busy = false,
  onClose,
  onConfiguredChange,
  onToggle,
  toolCalls,
  toolset
}: {
  busy?: boolean
  onClose: () => void
  onConfiguredChange: () => void
  onToggle: (toolset: ToolsetInfo, enabled: boolean) => void
  toolCalls: Record<string, number>
  toolset: null | ToolsetInfo
}) {
  const { t } = useI18n()
  const navigate = useNavigate()

  return (
    <Dialog onOpenChange={open => !open && onClose()} open={toolset !== null}>
      <DialogContent className="max-w-2xl" data-testid="toolset-detail">
        {toolset && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate">{toolsetCopy(toolset, t).label}</span>
                {!toolset.configured && <StatusPill tone="warn">{t.skills.needsKeys}</StatusPill>}
              </DialogTitle>
              <DialogDescription className="text-base">
                {toolsetCopy(toolset, t).description || t.skills.noDescription}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4">
              {toolset.name === 'vision' && (
                // Vision has no provider matrix — model resolution runs through
                // the auxiliary model config. Point at the actual home
                // (Settings → Models, aux "vision" row) via an internal deep link.
                <div className="grid gap-1.5">
                  <p className="text-sm text-(--ui-text-tertiary)">{t.skills.visionModelHint}</p>
                  <div>
                    <Button
                      onClick={() => {
                        onClose()
                        navigate(`${SETTINGS_ROUTE}?tab=config:model&aux=vision`)
                      }}
                      size="sm"
                      variant="textStrong"
                    >
                      {t.skills.visionModelLink}
                    </Button>
                  </div>
                </div>
              )}
              {toolset.name === 'computer_use' && <ComputerUsePanel onConfiguredChange={onConfiguredChange} />}
              {toolset.name === 'terminal' && <TerminalBackendPanel onConfiguredChange={onConfiguredChange} />}
              <ToolsetConfigPanel key={toolset.name} onConfiguredChange={onConfiguredChange} toolset={toolset.name} />
              <TechnicalDetails>
                <TechnicalDetailRow
                  label={t.skills.originalName}
                  value={<span className="font-mono">{toolset.name}</span>}
                />
                {toolNames(toolset).length > 0 && (
                  // The count leads the chips: "14 chức năng" is the sentence a
                  // person reads, the mono names under it are for whoever needs
                  // them. It used to sit on the card, where nobody could act on
                  // it; here it labels the list it describes.
                  <div className="grid gap-1">
                    <span className="text-sm text-(--ui-text-tertiary)">
                      {t.skills.toolsetFunctions(toolNames(toolset).length)}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {toolNames(toolset).map(name => (
                        <ToolChip key={name}>
                          {name}
                          {(toolCalls[name] ?? 0) > 0 && (
                            <span className="ml-1 text-(--ui-text-quaternary)">×{compactNumber(toolCalls[name])}</span>
                          )}
                        </ToolChip>
                      ))}
                    </div>
                  </div>
                )}
              </TechnicalDetails>
            </div>

            <DialogFooter className="items-center sm:justify-start">
              <label className="flex items-center gap-2 text-sm text-(--ui-text-secondary)">
                <Switch
                  aria-label={t.skills.toggleToolset(toolsetCopy(toolset, t).label, !toolset.enabled)}
                  checked={toolset.enabled}
                  className="cursor-pointer"
                  disabled={busy}
                  onCheckedChange={enabled => onToggle(toolset, enabled)}
                  size="md"
                />
                {toolset.enabled ? t.skills.toolsetEnabled : t.skills.toolsetDisabled}
              </label>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
