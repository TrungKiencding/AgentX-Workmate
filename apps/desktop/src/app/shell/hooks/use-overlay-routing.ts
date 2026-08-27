import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { type CommandCenterSection } from '@/app/command-center'
import {
  AGENTS_ROUTE,
  appViewForPath,
  COMMAND_CENTER_ROUTE,
  isOverlayView,
  NEW_CHAT_ROUTE,
  STARMAP_ROUTE
} from '@/app/routes'
import { PROFILE_MANAGEMENT_ENABLED } from '@/lib/product-flags'

const SECTIONS = ['sessions', 'system', 'usage'] as const

export function useOverlayRouting() {
  const location = useLocation()
  const navigate = useNavigate()

  const currentView = appViewForPath(location.pathname)
  const settingsOpen = currentView === 'settings'
  const commandCenterOpen = currentView === 'command-center'
  const agentsOpen = currentView === 'agents'
  const starmapOpen = currentView === 'starmap'
  const cronOpen = currentView === 'cron'
  // Profile management is hidden (PROFILE_MANAGEMENT_ENABLED), so `/profiles`
  // has no view left to render. Report it closed — and bounce the route below —
  // rather than opening an empty overlay card over the chat.
  const profilesOpen = PROFILE_MANAGEMENT_ENABLED && currentView === 'profiles'
  const webhooksOpen = currentView === 'webhooks'
  const chatOpen = currentView === 'chat'
  const overlayOpen = isOverlayView(currentView)

  // Overlay routes (settings/command-center/agents) stash the underlying path
  // so closing them returns there instead of bouncing to /.
  const returnPathRef = useRef(NEW_CHAT_ROUTE)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!overlayOpen) {
      returnPathRef.current = `${location.pathname}${location.search}${location.hash}`
    }
  }, [location.hash, location.pathname, location.search, overlayOpen])

  const commandCenterInitialSection = useMemo<CommandCenterSection | undefined>(
    () => SECTIONS.find(value => value === new URLSearchParams(location.search).get('section')),
    [location.search]
  )

  const openCommandCenterSection = useCallback(
    (section: CommandCenterSection) => navigate(`${COMMAND_CENTER_ROUTE}?section=${section}`),
    [navigate]
  )

  const resetOverlayReturnRoute = useCallback(() => {
    returnPathRef.current = NEW_CHAT_ROUTE
  }, [])

  const closeOverlayToPreviousRoute = useCallback(
    () => navigate(returnPathRef.current || NEW_CHAT_ROUTE, { replace: true }),
    [navigate]
  )

  // A stale deep link, a restored window, or a bookmark can still name
  // `/profiles` after the feature was hidden. Send it back where the user came
  // from (chat on a cold start) so nobody lands on a blank overlay with no
  // close button to press.
  useEffect(() => {
    if (!PROFILE_MANAGEMENT_ENABLED && currentView === 'profiles') {
      navigate(returnPathRef.current || NEW_CHAT_ROUTE, { replace: true })
    }
  }, [currentView, navigate])

  const toggleCommandCenter = useCallback(() => {
    if (commandCenterOpen) {
      closeOverlayToPreviousRoute()
    } else {
      navigate(COMMAND_CENTER_ROUTE)
    }
  }, [closeOverlayToPreviousRoute, commandCenterOpen, navigate])

  const openAgents = useCallback(() => navigate(AGENTS_ROUTE), [navigate])
  const openStarmap = useCallback(() => navigate(STARMAP_ROUTE), [navigate])

  return {
    agentsOpen,
    chatOpen,
    closeOverlayToPreviousRoute,
    commandCenterInitialSection,
    commandCenterOpen,
    cronOpen,
    currentView,
    openAgents,
    openCommandCenterSection,
    openStarmap,
    profilesOpen,
    resetOverlayReturnRoute,
    settingsOpen,
    starmapOpen,
    toggleCommandCenter,
    webhooksOpen
  }
}
