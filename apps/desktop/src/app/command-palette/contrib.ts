/**
 * Command-palette contribution surface — `palette` data contributions become
 * rows in the ⌘K root list, same schema as every other area. Contributions
 * with an `action` id render that action's live keybind as their hotkey hint.
 */

import { useContributions } from '@/contrib/react/use-contributions'
import type { IconComponent } from '@/lib/icons'

export const PALETTE_AREA = 'palette'

/**
 * A row's text. A function when it is translated: contributions register once
 * at boot, in whatever language the app happened to start in, so a string
 * captured there stayed in that language after the person switched (pilot
 * feedback 2026-11-10: "chưa đồng bộ khi chuyển đổi ngôn ngữ"). The palette
 * calls it each time it renders.
 */
export type ContributedLabel = (() => string) | string

export const resolveContributedLabel = (label: ContributedLabel | undefined): string =>
  (typeof label === 'function' ? label() : label) ?? ''

/** Payload of a `palette` data contribution. */
export interface PaletteContribution {
  id: string
  label: ContributedLabel
  /** Keybind action id — its live combo renders as the hotkey hint. */
  action?: string
  icon?: IconComponent
  keywords?: string[]
  run: () => void
  /**
   * Short note after the label — the live state the row acts on. A function
   * because contributions register once at boot while that state keeps moving;
   * the palette re-reads it on open.
   */
  detail?: () => string
  /** `state` when running the row CHANGES what `detail` says. */
  detailVariant?: 'muted' | 'state'
  /** Leave the palette open after running — for rows you may run repeatedly. */
  keepOpen?: boolean
}

/** A contributed row as the palette renders it: its label resolved to text. */
export type PaletteContributionRow = Omit<PaletteContribution, 'label'> & { key: string; label: string }

/** Contributed palette rows, with stable render keys. Labels are read in the
 *  app's current language on every render (the palette re-renders on a
 *  language switch). */
export function usePaletteContributions(): PaletteContributionRow[] {
  return useContributions(PALETTE_AREA)
    .map(c => {
      const data = c.data as PaletteContribution

      return { ...data, key: `${c.source ?? 'core'}:${c.id}`, label: resolveContributedLabel(data?.label) }
    })
    .filter(item => Boolean(item.label && item.run))
}

/**
 * A binary setting as one palette row: `Toggle status bar` trailed by the live
 * state. The verb says what the row does, the note says where it stands —
 * neither alone is enough to act on.
 *
 * Rows keep the palette open: flipping a setting is the kind of thing you do
 * two or three of in a row, and the note updating in place is the receipt.
 */
export function paletteToggle(
  spec: Omit<PaletteContribution, 'detail' | 'detailVariant' | 'keepOpen' | 'run'> & {
    get: () => boolean
    set: (enabled: boolean) => void
  }
) {
  const { get, keywords = [], set, ...rest } = spec

  const data: PaletteContribution = {
    ...rest,
    detail: () => (get() ? 'on' : 'off'),
    detailVariant: 'state',
    keepOpen: true,
    keywords: [...keywords, 'on', 'off', 'enable', 'disable'],
    run: () => set(!get())
  }

  return { id: data.id, area: PALETTE_AREA, data }
}
