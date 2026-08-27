import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { $activeGatewayProfile } from '@/store/profile'

/** Run `onSwitch` when the active gateway profile changes — never on first
 *  mount. For dropping per-profile view state (probes, cached usage, drafts)
 *  when the backend the app talks to swaps underneath a still-mounted view.
 *
 *  The guard compares the profile VALUE, not a "have I run before" flag: a
 *  flag survives StrictMode's simulated remount (setup → cleanup → setup), so
 *  the second setup read it as "already mounted, this must be a switch" and
 *  fired a phantom switch on every remount in dev — dropping drafts nothing
 *  was going to restore. Comparing values can't be fooled by a remount, and
 *  a real change still fires exactly once. */
export function useOnProfileSwitch(onSwitch: () => void): void {
  const profile = useStore($activeGatewayProfile)
  const seen = useRef(profile)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (seen.current === profile) {
      return
    }

    seen.current = profile
    onSwitch()
    // Fire on profile change only; onSwitch identity is intentionally ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])
}
