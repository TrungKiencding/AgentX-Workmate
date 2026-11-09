import { host, icons, SegmentedControl } from '@agentx/plugin-sdk'
import { useCallback, useRef, useSyncExternalStore } from 'react'

import { useBots } from './i18n'

const readRoute = () => window.location.hash.slice(1) || '/'
const isAssistants = (route: string) => route.split(/[?#]/, 1)[0] === '/bots'

/** Navigation only: switching destinations never resets a chat or its profile. */
export function WorkspaceSwitcher() {
  const b = useBots()
  const initialRoute = readRoute()

  const returnToWork = useRef<string | null>(isAssistants(initialRoute) ? null : initialRoute)

  const subscribeRoute = useCallback((notify: () => void) => {
    const onRoute = () => {
      const next = readRoute()

      if (!isAssistants(next)) {
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
      onChange={next => {
        if (next === value) {
          return
        }

        if (next === 'assistants') {
          host.navigate('/bots')
        } else {
          const sessionId = host.state.storedSessionId.get()
          host.navigate(returnToWork.current ?? (sessionId ? `/${encodeURIComponent(sessionId)}` : '/'))
        }
      }}
      options={[
        { id: 'work', label: b.work, icon: icons.Briefcase },
        { id: 'assistants', label: b.nav, icon: icons.Users }
      ]}
      value={value}
    />
  )
}
