import { useStore } from '@nanostores/react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { AppWindow } from '@/lib/icons'
import {
  $webmateBrowsers,
  $webmatePrompt,
  applyWebmateUpdate,
  dismissWebmatePrompt,
  hasChromiumBrowser,
  openWebmateWindow
} from '@/store/webmate'

import { SETTINGS_ROUTE } from '../app/routes'

/**
 * "Workmate muốn dùng trình duyệt của bạn": shown once per session when a
 * webmate tool fails with a WEBMATE_* code (store/webmate.ts decides when).
 * Three doors, as the plan asks: do it now (Settings → Trình duyệt, or the
 * update itself), not now (snoozed a day), never (Settings → "Không hỏi").
 */
export function WebmatePromptCard() {
  const { t } = useI18n()
  const prompt = useStore($webmatePrompt)
  const browsers = useStore($webmateBrowsers)
  const navigate = useNavigate()

  if (!prompt) {
    return null
  }

  const copy = t.webmate.prompt
  const code = prompt.code

  const primaryLabel =
    code === 'WEBMATE_NOT_INSTALLED' ? copy.install : code === 'WEBMATE_OUTDATED' ? t.webmate.update.install : copy.open

  const primary = () => {
    dismissWebmatePrompt('acted')

    if (code === 'WEBMATE_OUTDATED') {
      void applyWebmateUpdate()

      return
    }

    navigate(`${SETTINGS_ROUTE}?tab=browser`)
  }

  return (
    <div
      className="pointer-events-auto fixed right-4 bottom-4 z-(--z-over-modal) w-[22rem] max-w-[calc(100vw-2rem)] rounded-(--radius-card) border border-(--ui-stroke-secondary) bg-(--ui-chat-bubble-background) p-4 shadow-nous"
      data-slot="webmate-prompt-card"
      role="dialog"
    >
      <div className="flex items-start gap-3">
        <span className="inline-grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <AppWindow className="size-4.5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{copy.title}</p>
          <p className="mt-1 text-sm leading-6 text-(--ui-text-tertiary)">{copy.body[code]}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button className="mr-auto font-medium" onClick={() => dismissWebmatePrompt('never')} size="xs" variant="text">
          {copy.never}
        </Button>
        <Button onClick={() => dismissWebmatePrompt('notNow')} size="sm" variant="outline">
          {copy.notNow}
        </Button>
        {code !== 'WEBMATE_PORT_IN_USE' && code !== 'WEBMATE_OUTDATED' && hasChromiumBrowser(browsers) !== false ? (
          <Button
            onClick={() => {
              dismissWebmatePrompt('acted')
              void openWebmateWindow()
              navigate(`${SETTINGS_ROUTE}?tab=browser`)
            }}
            size="sm"
            variant="outline"
          >
            {t.webmate.window.open}
          </Button>
        ) : null}
        {code === 'WEBMATE_PORT_IN_USE' ? null : (
          <Button onClick={primary} size="sm">
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
