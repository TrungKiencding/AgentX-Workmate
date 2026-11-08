/**
 * An assistant's own model — the composer's model menu (same search, provider
 * groups and families), held as form state instead of writing to a session.
 * Empty = use the app default.
 */

import {
  Button,
  cn,
  Codicon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  ModelCatalogMenu,
  ModelMenuCloseContext,
  type ModelMenuController
} from '@agentx/plugin-sdk'
import { useState } from 'react'

import { useBots } from './i18n'

export interface ModelChoiceValue {
  model: string
  provider: string
}

export const INHERIT_MODEL: ModelChoiceValue = { model: '', provider: '' }

export const isInheritModel = (value: ModelChoiceValue) => !value.model.trim() || !value.provider.trim()

export function ModelField({
  onChange,
  profile,
  value
}: {
  onChange: (next: ModelChoiceValue) => void
  /** Whose catalog to list (an existing assistant), else the main profile's. */
  profile?: string
  value: ModelChoiceValue
}) {
  const b = useBots()
  const [open, setOpen] = useState(false)
  const inherit = isInheritModel(value)

  const controller: ModelMenuController = {
    applyPreset: (_preset, row) => onChange({ model: row.model, provider: row.provider }),
    current: { effort: '', fast: false, model: value.model, provider: value.provider },
    presetFor: () => ({}),
    select: (model, provider) => onChange({ model, provider }),
    // An assistant stores a model, not a thinking depth or a speed — so the
    // menu offers neither rather than showing controls that would do nothing.
    options: { effort: false, fast: false },
    setOptions: () => undefined
  }

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn('w-full justify-between gap-2 px-3 font-normal', inherit && 'text-(--text-secondary)')}
          type="button"
          variant="outline"
        >
          <span className="min-w-0 truncate">{inherit ? b.modelInherit : value.model}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {!inherit && (
              <span
                aria-label={b.modelInherit}
                className="grid size-5 place-items-center rounded-sm text-(--text-tertiary) hover:bg-(--bg-hover) hover:text-(--text-primary)"
                onClick={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  onChange(INHERIT_MODEL)
                }}
                onPointerDown={event => event.stopPropagation()}
                role="button"
              >
                <Codicon name="close" size="0.75rem" />
              </span>
            )}
            <Codicon className="opacity-50" name="chevron-down" size="0.75rem" />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-0">
        <ModelMenuCloseContext.Provider value={() => setOpen(false)}>
          <ModelCatalogMenu controller={controller} profile={profile} />
        </ModelMenuCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
