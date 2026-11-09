import { SidebarHeader } from '@/components/ui/sidebar'
import { Slot } from '@/contrib/react/slot'
import { useContributions } from '@/contrib/react/use-contributions'

import { SIDEBAR_HEADER_AREA } from '../../routes'

/** No contribution, no reserved space. The header stays mounted with the rail. */
export function SidebarHeaderSlot() {
  const contributions = useContributions(SIDEBAR_HEADER_AREA)

  if (contributions.length === 0) {
    return null
  }

  return (
    <SidebarHeader className="shrink-0 px-0 pb-1 pt-2">
      <Slot area={SIDEBAR_HEADER_AREA} />
    </SidebarHeader>
  )
}
