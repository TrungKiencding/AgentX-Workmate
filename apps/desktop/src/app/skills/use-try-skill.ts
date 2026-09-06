import { useCallback } from 'react'
import { useNavigate } from 'react-router'

import { requestComposerInsert } from '../chat/composer/focus'
import { NEW_CHAT_ROUTE } from '../routes'

// "Thử ngay": land on a fresh chat and pre-type the skill's slash command.
// Both are existing actions — navigation to the new-chat route, then the
// composer-insert bus (its dispatch defers a macrotask, so the main composer
// is mounted by the time the event fires). Shared by the skills you have and
// the ones the store just added, so trying a skill is one gesture everywhere.
export function useTrySkill(): (skillName: string) => void {
  const navigate = useNavigate()

  return useCallback(
    (skillName: string) => {
      navigate(NEW_CHAT_ROUTE)
      requestComposerInsert(`/${skillName} `, { mode: 'inline', target: 'main' })
    },
    [navigate]
  )
}
