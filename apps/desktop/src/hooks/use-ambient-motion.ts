import { useEffect, useState } from 'react'

import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { createRendererLoopPauseController } from '@/lib/renderer-loop-pause'

import { useMediaQuery } from './use-media-query'

/**
 * Whether an ambient loop — motion that answers no input, like a wait that
 * animates until a reply lands — should be running right now: never under
 * reduced motion, never in a kept-alive tab that is hidden, and only while the
 * window is focused and on screen. That last one is `StatusPulse`'s sleep
 * policy: a continuous loop keeps the renderer producing a frame every vsync,
 * so it stops the moment nobody is looking at the window, and picks up again
 * on focus.
 */
export function useAmbientMotion(): boolean {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const paneVisible = usePaneVisible()
  const windowAwake = useWindowAwake()

  return !reducedMotion && paneVisible && windowAwake
}

function useWindowAwake(): boolean {
  const [awake, setAwake] = useState(() => document.visibilityState !== 'hidden' && document.hasFocus())

  useEffect(() => {
    let controller: null | ReturnType<typeof createRendererLoopPauseController> = null

    const sync = () => {
      if (controller) {
        setAwake(!controller.isPaused())
      }
    }

    controller = createRendererLoopPauseController(sync)
    sync()

    return () => controller?.dispose()
  }, [])

  return awake
}
