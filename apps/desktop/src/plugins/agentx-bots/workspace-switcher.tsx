import { host, icons, isOverlayRoute, SegmentedControl } from '@agentx/plugin-sdk'
import { useCallback, useRef, useSyncExternalStore } from 'react'

import { useBots } from './i18n'

const readRoute = () => window.location.hash.slice(1) || '/'
const isAssistants = (route: string) => route.split(/[?#]/, 1)[0] === '/bots'
const isWorkDestination = (route: string) => !isAssistants(route) && !isOverlayRoute(route)

/** Navigation only: switching destinations never resets a chat or its profile. */
export function WorkspaceSwitcher() {
  const b = useBots()
  const initialRoute = readRoute()

  const returnToWork = useRef<string | null>(isWorkDestination(initialRoute) ? initialRoute : null)

  const subscribeRoute = useCallback((notify: () => void) => {
    const onRoute = () => {
      const next = readRoute()

      if (isWorkDestination(next)) {
        returnToWork.current = next
      }

      notify()
    }

    window.addEventListener('hashchange', onRoute)

    return () => window.removeEventListener('hashchange', onRoute)
  }, [])

  const route = useSyncExternalStore(subscribeRoute, readRoute, () => '/')
  const assistantsOpen = isAssistants(route)
  const value = assistantsOpen ? 'assistants' : 'work'

  return (
    <SegmentedControl
      aria-label={b.workspaceNavigation}
      className="w-full"
      onChange={next => {
        // Clicks may precede React's hashchange render. The live route owns
        // intent, including rapid alternating clicks and a just-selected task.
        const current = readRoute()

        if (next === 'assistants') {
          if (isWorkDestination(current)) {
            returnToWork.current = current
          }

          // Re-clicks still front the roster when a session tile obscures it.
          host.navigate('/bots')
        } else if (isAssistants(current)) {
          const sessionId = host.state.storedSessionId.get()
          host.navigate(returnToWork.current ?? (sessionId ? `/${encodeURIComponent(sessionId)}` : '/'))
        }
      }}
      options={[
        { id: 'work', label: b.work, icon: icons.Briefcase },
        { id: 'assistants', label: b.nav, icon: icons.Users }
      ]}
      size="md"
      value={value}
    />
  )
}
