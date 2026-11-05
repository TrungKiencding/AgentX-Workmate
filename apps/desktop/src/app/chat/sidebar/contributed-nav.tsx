import { Codicon } from '@/components/ui/codicon'
import type { Contribution } from '@/contrib/types'
import type { Locale } from '@/i18n'
import { cn } from '@/lib/utils'

import type { SidebarNavContribution, SidebarNavTint } from '../../routes'
import type { SidebarNavItem } from '../../types'

// Contributed rows pick a tint by name; spelled out so Tailwind emits each class.
export const CONTRIBUTED_GLYPH_TINT: Record<SidebarNavTint, string> = {
  blue: 'text-(--tint-blue)',
  green: 'text-(--tint-green)',
  indigo: 'text-(--tint-indigo)',
  orange: 'text-(--tint-orange)',
  pink: 'text-(--tint-pink)',
  purple: 'text-(--tint-purple)',
  red: 'text-(--tint-red)',
  teal: 'text-(--tint-teal)',
  yellow: 'text-(--tint-yellow)'
}

/** `sidebar.nav` contributions → nav rows. Rows without an absolute path or a
 *  label are dropped; a function label is resolved for `locale`. */
export function contributedNavItems(contributions: readonly Contribution[], locale: Locale): SidebarNavItem[] {
  return contributions.flatMap(c => {
    const data = c.data as Partial<SidebarNavContribution> | undefined
    const label = typeof data?.label === 'function' ? data.label(locale) : data?.label

    if (!data?.path?.startsWith('/') || !label) {
      return []
    }

    const codicon = data.codicon || 'plug'
    // Same quiet tint the built-in destinations wear; cn() lets it win over
    // the row's neutral glyph ink.
    const tint = data.tint ? CONTRIBUTED_GLYPH_TINT[data.tint] : undefined

    return [
      {
        id: c.id,
        label,
        // A codicon is a font glyph: give it the 20px box the built-in rows'
        // SVG glyphs get from NAV_ROW, so contributed labels line up.
        icon: ({ className }: { className?: string }) => (
          <Codicon className={cn('w-5 shrink-0 text-center text-[1.125rem]', className, tint)} name={codicon} />
        ),
        route: data.path
      }
    ]
  })
}
