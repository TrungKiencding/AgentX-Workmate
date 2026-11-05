/**
 * Create and edit an assistant.
 *
 * Create is one short form — templates, picture, name, "what it helps with" —
 * with everything technical folded under "Advanced". Edit splits the same
 * fields into three non-overlapping parts: Profile · Behavior · Skills & tools.
 */

import {
  Button,
  Checkbox,
  cn,
  Codicon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  GlyphSpinner,
  host,
  Input,
  SearchField,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from '@agentx/plugin-sdk'
import { type ReactNode, useEffect, useId, useState } from 'react'

import { AvatarPicker, type AvatarValue } from './avatar-picker'
import type { AVATAR_SHAPES } from './face'
import { AVATAR_COLORS, botAppearance } from './face'
import { type BotsText, TEMPLATE_IDS, type TemplateId, useBots } from './i18n'
import { INHERIT_MODEL, isInheritModel, type ModelChoiceValue, ModelField } from './model-field'
import { botHandle, displayName, foldForSearch, NAME_RE, uniqueName } from './naming'
import { $botMeta, invalidateRoster, type MetaSaveOutcome, saveBotMeta } from './state'
import type { Bot } from './types'

// ── shared bits ──────────────────────────────────────────────────────────────

export function Field({
  children,
  help,
  htmlFor,
  label
}: {
  children: ReactNode
  help?: ReactNode
  htmlFor?: string
  label: ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium text-(--text-primary)" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {help ? <p className="text-xs leading-5 text-(--text-tertiary)">{help}</p> : null}
    </div>
  )
}

const TEMPLATE_LOOK: Record<TemplateId, { color: string; shape: (typeof AVATAR_SHAPES)[number] }> = {
  research: { color: '#3b82f6', shape: 'circle' },
  writer: { color: '#ec4899', shape: 'blob' },
  secretary: { color: '#14b8a6', shape: 'squircle' },
  analyst: { color: '#f59e0b', shape: 'hexagon' },
  translator: { color: '#8b5cf6', shape: 'cloud' }
}

/** SOUL.md for a new assistant: who it is, what it's for, the user's own
 *  instructions. The teammate protocol is NOT here — the backend adds it to
 *  the assistant's main conversation itself. */
export function composeSoul({
  description,
  handle,
  instructions,
  title
}: {
  description: string
  handle: string
  instructions: string
  title: string
}): string {
  const lines = [
    `# ${title}`,
    '',
    description ? `**Role:** ${description}` : null,
    '',
    `You are ${title}, a persistent named assistant (profile \`${handle}\`) on this machine.`,
    'You keep your own memory, skills and conversation history across sessions.',
    instructions.trim() ? `\n## Instructions\n\n${instructions.trim()}` : null
  ]

  return lines.filter(line => line !== null).join('\n') + '\n'
}

function DialogShell({
  busy,
  children,
  description,
  footer,
  onClose,
  open,
  title,
  wide = false
}: {
  busy: boolean
  children: ReactNode
  description: ReactNode
  footer: ReactNode
  onClose: () => void
  open: boolean
  title: ReactNode
  wide?: boolean
}) {
  return (
    <Dialog onOpenChange={value => !value && !busy && onClose()} open={open}>
      <DialogContent
        className={cn(
          'flex flex-col gap-0 p-0',
          // The tabbed editor keeps ONE height across its parts, so switching
          // parts never moves the part switcher under the pointer.
          wide ? 'h-[min(44rem,90vh)] sm:max-w-xl' : 'max-h-[min(44rem,90vh)] sm:max-w-lg'
        )}
        // Opening on the part switcher would paint a focus ring on "Profile"
        // that stays behind when another part is picked; start on the dialog.
        onOpenAutoFocus={wide ? event => event.preventDefault() : undefined}
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-2">{children}</div>
        <DialogFooter className="shrink-0 px-6 pt-3 pb-5">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── create ──────────────────────────────────────────────────────────────────

interface CreateState {
  advanced: boolean
  avatar: AvatarValue
  clone: string
  description: string
  handle: string
  /** The user typed the handle themselves — stop deriving it from the name. */
  handleEdited: boolean
  instructions: string
  model: ModelChoiceValue
  name: string
  shareAuth: boolean
  template: TemplateId | null
}

const FRESH = '__fresh__'

const initialCreate = (): CreateState => ({
  advanced: false,
  avatar: { color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)], image: null, shape: 'circle' },
  clone: 'default',
  description: '',
  handle: '',
  handleEdited: false,
  instructions: '',
  model: INHERIT_MODEL,
  name: '',
  shareAuth: true,
  template: null
})

export function CreateAgentDialog({
  onClose,
  onCreated,
  open,
  roster
}: {
  onClose: () => void
  onCreated: (name: string) => void
  open: boolean
  roster: readonly Bot[]
}) {
  const b = useBots()
  const ids = { desc: useId(), handle: useId(), instructions: useId(), name: useId() }
  const [state, setState] = useState<CreateState>(initialCreate)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const taken = roster.map(bot => bot.name)

  useEffect(() => {
    if (open) {
      setState(initialCreate())
      setBusy(false)
      setError(null)
    }
  }, [open])

  const set = (patch: Partial<CreateState>) => setState(prev => ({ ...prev, ...patch }))

  const handle = state.handleEdited ? state.handle : state.name.trim() ? uniqueName(state.name, taken) || '' : ''
  const handleInvalid = state.handleEdited && !NAME_RE.test(state.handle)
  const handleTaken = taken.includes(handle)
  const canSubmit = Boolean(state.name.trim()) && Boolean(handle) && !handleInvalid && !handleTaken && !busy

  const applyTemplate = (id: TemplateId) => {
    const template = b.template[id]
    const previous = state.template ? b.template[state.template] : null

    set({
      template: id,
      // Never overwrite what the user typed themselves.
      name: !state.name.trim() || state.name === previous?.title ? template.title : state.name,
      description:
        !state.description.trim() || state.description === previous?.description
          ? template.description
          : state.description,
      avatar: state.avatar.image ? state.avatar : { ...state.avatar, ...TEMPLATE_LOOK[id] }
    })
  }

  const submit = async () => {
    if (!canSubmit) {
      return
    }

    setBusy(true)
    setError(null)

    const title = state.name.trim()
    const description = state.description.trim()

    try {
      await host.request('profiles.create', {
        name: handle,
        description,
        clone_from: state.clone === FRESH ? null : state.clone,
        share_auth: state.shareAuth,
        soul: composeSoul({ description, handle, instructions: state.instructions, title }),
        ...(isInheritModel(state.model) ? {} : { model: state.model.model, provider: state.model.provider })
      })

      await saveBotMeta(handle, {
        color: state.avatar.color,
        created: Date.now(),
        custom: true,
        image: state.avatar.image,
        imageKind: state.avatar.image ? 'photo' : 'shape',
        shape: state.avatar.shape,
        title
      })
      await Promise.all([invalidateRoster(), host.refreshProfiles().catch(() => undefined)])
      host.notify({ kind: 'success', message: b.created(title) })
      onCreated(handle)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <DialogShell
      busy={busy}
      description={b.createDescription}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="outline">
            {b.cancel}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? b.creating : b.createAction}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={b.createTitle}
    >
      <form
        className="grid gap-5"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid gap-2">
          <span className="text-sm font-medium text-(--text-primary)">{b.templates}</span>
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATE_IDS.map(id => (
              <button
                aria-pressed={state.template === id}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-(--dur-micro)',
                  state.template === id
                    ? 'border-(--border-strong) bg-(--bg-selected) text-(--text-primary)'
                    : 'border-(--border-default) text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)'
                )}
                key={id}
                onClick={() => applyTemplate(id)}
                type="button"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: TEMPLATE_LOOK[id].color }}
                />
                {b.template[id].title}
              </button>
            ))}
          </div>
        </div>

        <AvatarPicker
          description={state.description}
          name={state.name || 'agent'}
          onChange={avatar => set({ avatar })}
          value={state.avatar}
        />

        <Field
          help={handle && !handleTaken && !state.advanced ? b.handleHint(handle) : undefined}
          htmlFor={ids.name}
          label={b.nameLabel}
        >
          <Input
            autoFocus
            id={ids.name}
            maxLength={80}
            onChange={event => set({ name: event.target.value })}
            placeholder={b.namePlaceholder}
            value={state.name}
          />
        </Field>

        <Field htmlFor={ids.desc} label={b.descLabel}>
          <Textarea
            className="min-h-20"
            id={ids.desc}
            onChange={event => set({ description: event.target.value })}
            placeholder={b.descPlaceholder}
            value={state.description}
          />
        </Field>

        <Disclosure label={b.advanced} onToggle={() => set({ advanced: !state.advanced })} open={state.advanced}>
          <Field
            help={
              handleInvalid ? (
                <Problem>{b.handleInvalid}</Problem>
              ) : handleTaken ? (
                <Problem>{b.handleTaken(handle)}</Problem>
              ) : (
                b.handleHelp
              )
            }
            htmlFor={ids.handle}
            label={b.handleLabel}
          >
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-(--text-tertiary)">
                @
              </span>
              <Input
                className="pl-7"
                id={ids.handle}
                maxLength={64}
                onChange={event => set({ handle: event.target.value.toLowerCase(), handleEdited: true })}
                value={handle}
              />
            </div>
          </Field>
          <Field label={b.cloneLabel}>
            <Select onValueChange={clone => set({ clone })} value={state.clone}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FRESH}>{b.cloneFresh}</SelectItem>
                {roster.map(bot => (
                  <SelectItem key={bot.name} value={bot.name}>
                    {b.cloneFrom(displayName(bot, $botMeta.get()[bot.name], b.primaryName))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field help={b.modelHelp} label={b.modelLabel}>
            <ModelField onChange={model => set({ model })} value={state.model} />
          </Field>
          <Field help={b.instructionsHelp} htmlFor={ids.instructions} label={b.instructionsLabel}>
            <Textarea
              className="min-h-24"
              id={ids.instructions}
              onChange={event => set({ instructions: event.target.value })}
              placeholder={b.instructionsPlaceholder}
              value={state.instructions}
            />
          </Field>
          <SwitchRow
            checked={state.shareAuth}
            help={b.shareAuthHelp}
            label={b.shareAuth}
            onChange={shareAuth => set({ shareAuth })}
          />
        </Disclosure>

        {error ? <Problem>{`${b.createFailed}: ${error}`}</Problem> : null}
        {/* Enter in a single-line field submits. */}
        <button className="hidden" disabled={!canSubmit} type="submit" />
      </form>
    </DialogShell>
  )
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-start gap-1.5 text-sm text-(--danger)" role="alert">
      <Codicon className="mt-0.5" name="warning" size="0.85rem" />
      <span>{children}</span>
    </span>
  )
}

function Disclosure({
  children,
  label,
  onToggle,
  open
}: {
  children: ReactNode
  label: string
  onToggle: () => void
  open: boolean
}) {
  return (
    <div className="grid gap-4">
      <button
        aria-expanded={open}
        className="flex w-fit items-center gap-1.5 text-sm font-medium text-(--text-secondary) hover:text-(--text-primary)"
        onClick={onToggle}
        type="button"
      >
        <Codicon
          className={cn('transition-transform duration-(--dur-micro)', open && 'rotate-90')}
          name="chevron-right"
          size="0.8rem"
        />
        {label}
      </button>
      {open ? <div className="grid gap-5 border-l border-(--border-default) pl-4">{children}</div> : null}
    </div>
  )
}

function SwitchRow({
  checked,
  help,
  label,
  onChange
}: {
  checked: boolean
  help?: string
  label: string
  onChange: (value: boolean) => void
}) {
  const id = useId()

  return (
    <div className="flex items-start justify-between gap-4">
      <label className="grid gap-0.5" htmlFor={id}>
        <span className="text-sm font-medium text-(--text-primary)">{label}</span>
        {help ? <span className="text-xs leading-5 text-(--text-tertiary)">{help}</span> : null}
      </label>
      <Switch checked={checked} id={id} onCheckedChange={onChange} />
    </div>
  )
}

// ── edit ────────────────────────────────────────────────────────────────────

interface SkillRow {
  description?: string
  enabled: boolean
  name: string
}

interface ToolsetRow extends SkillRow {
  tool_count?: number
}

interface Describe {
  description?: string
  model?: { default?: string; provider?: string }
  skills?: SkillRow[]
  soul?: string
  toolsets?: ToolsetRow[]
}

type EditTab = 'behavior' | 'profile' | 'skills'

interface EditState {
  avatar: AvatarValue
  description: string
  dirty: { model: boolean; skills: boolean; soul: boolean; toolsets: boolean }
  model: ModelChoiceValue
  skills: SkillRow[]
  soul: string
  title: string
  toolsets: ToolsetRow[]
}

export function EditAgentDialog({ bot, onClose }: { bot: Bot | null; onClose: () => void }) {
  const b = useBots()
  const open = Boolean(bot)
  const [tab, setTab] = useState<EditTab>('profile')
  const [state, setState] = useState<EditState | null>(null)
  const [described, setDescribed] = useState<'error' | 'loading' | 'ready'>('loading')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('')
  const ids = { desc: useId(), name: useId(), soul: useId() }

  useEffect(() => {
    if (!bot) {
      return
    }

    let cancelled = false
    const meta = $botMeta.get()[bot.name]
    const look = botAppearance(bot.name, meta)

    setTab('profile')
    setBusy(false)
    setFilter('')
    setDescribed('loading')
    setState({
      avatar: look,
      description: bot.description || '',
      dirty: { model: false, skills: false, soul: false, toolsets: false },
      model: { model: bot.model || '', provider: bot.provider || '' },
      skills: [],
      soul: '',
      title: meta?.title || '',
      toolsets: []
    })

    host
      .request<Describe>('profiles.describe', { name: bot.name })
      .then(res => {
        if (cancelled) {
          return
        }

        setState(
          prev =>
            prev && {
              ...prev,
              model: { model: res.model?.default || '', provider: res.model?.provider || '' },
              skills: (res.skills || []).slice().sort((x, y) => x.name.localeCompare(y.name)),
              soul: res.soul || '',
              toolsets: res.toolsets || []
            }
        )
        setDescribed('ready')
      })
      .catch(() => !cancelled && setDescribed('error'))

    return () => {
      cancelled = true
    }
  }, [bot])

  if (!bot || !state) {
    return null
  }

  const name = displayName(bot, { title: state.title }, b.primaryName)
  const set = (patch: Partial<EditState>) => setState(prev => prev && { ...prev, ...patch })

  const touch = (key: keyof EditState['dirty']) =>
    setState(prev => prev && { ...prev, dirty: { ...prev.dirty, [key]: true } })

  const save = async () => {
    setBusy(true)
    const failed: string[] = []

    const outcome: MetaSaveOutcome = await saveBotMeta(bot.name, {
      color: state.avatar.color,
      custom: true,
      image: state.avatar.image,
      imageKind: state.avatar.image ? 'photo' : 'shape',
      shape: state.avatar.shape,
      title: state.title.trim()
    })

    const payload: Record<string, unknown> = { name: bot.name }

    if (state.description.trim() !== (bot.description || '').trim()) {
      payload.description = state.description.trim()
    }

    if (state.dirty.soul) {
      payload.soul = state.soul
    }

    if (state.dirty.model && !isInheritModel(state.model)) {
      payload.model = state.model.model
      payload.provider = state.model.provider
    }

    if (state.dirty.skills) {
      payload.disabled_skills = state.skills.filter(skill => !skill.enabled).map(skill => skill.name)
    }

    if (state.dirty.toolsets) {
      const enabled = state.toolsets.filter(toolset => toolset.enabled)
      // All (or none) checked = no pin: the default toolset behavior.
      payload.enabled_toolsets =
        enabled.length === state.toolsets.length || enabled.length === 0 ? [] : enabled.map(toolset => toolset.name)
    }

    try {
      if (Object.keys(payload).length > 1) {
        const res = await host.request<{ applied?: Record<string, boolean> }>('profiles.configure', payload)
        failed.push(
          ...Object.entries(res?.applied || {})
            .filter(([, ok]) => !ok)
            .map(([key]) => key)
        )
      }

      if (state.dirty.model && isInheritModel(state.model)) {
        const res = await host.request<{ blocked?: boolean; code?: number }>('cli.exec', {
          argv: ['--profile', bot.name, 'config', 'unset', 'model']
        })

        if (res?.blocked || res?.code !== 0) {
          failed.push('model')
        }
      }
    } catch (error) {
      failed.push(errorText(error))
    }

    await invalidateRoster()

    if (failed.length) {
      host.notify({ kind: 'error', message: b.partialSave(failed.join(', ')) })
    } else if (outcome === 'failed') {
      host.notify({ kind: 'warning', message: b.savedLocally })
    } else {
      host.notify({ kind: 'success', message: b.saved(name) })
    }

    setBusy(false)
    onClose()
  }

  const needle = foldForSearch(filter)
  const skills = needle ? state.skills.filter(skill => foldForSearch(skill.name).includes(needle)) : state.skills

  return (
    <DialogShell
      busy={busy}
      description={b.editDescription(name)}
      footer={
        <>
          <Button disabled={busy} onClick={onClose} variant="outline">
            {b.cancel}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? b.saving : b.save}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={b.editTitle}
      wide
    >
      <div className="grid gap-5">
        <SegmentedControl
          className="w-full"
          onChange={setTab}
          options={[
            { id: 'profile', label: b.tabProfile },
            { id: 'behavior', label: b.tabBehavior },
            { id: 'skills', label: b.tabSkills }
          ]}
          size="md"
          value={tab}
        />

        {tab === 'profile' ? (
          <div className="grid gap-5">
            <AvatarPicker
              description={state.description}
              name={name}
              onChange={avatar => set({ avatar })}
              value={state.avatar}
            />
            <Field help={b.handleHint(botHandle(bot.name))} htmlFor={ids.name} label={b.nameLabel}>
              <Input
                id={ids.name}
                maxLength={80}
                onChange={event => set({ title: event.target.value })}
                placeholder={displayName(bot, null, b.primaryName)}
                value={state.title}
              />
            </Field>
            <Field htmlFor={ids.desc} label={b.descLabel}>
              <Textarea
                className="min-h-20"
                id={ids.desc}
                onChange={event => set({ description: event.target.value })}
                placeholder={b.descPlaceholder}
                value={state.description}
              />
            </Field>
          </div>
        ) : described === 'loading' ? (
          <div className="grid place-items-center py-12">
            <GlyphSpinner className="text-(--text-tertiary)" spinner="breathe" />
          </div>
        ) : described === 'error' ? (
          <p className="py-8 text-center text-sm text-(--text-tertiary)">{b.capsLoadError}</p>
        ) : tab === 'behavior' ? (
          <div className="grid gap-5">
            <Field help={b.modelHelp} label={b.modelLabel}>
              <ModelField
                onChange={model => {
                  set({ model })
                  touch('model')
                }}
                profile={bot.name}
                value={state.model}
              />
            </Field>
            <Field help={b.instructionsHelp} htmlFor={ids.soul} label={b.instructionsLabel}>
              <Textarea
                className="min-h-56 font-mono text-[0.8125rem] leading-5"
                id={ids.soul}
                onChange={event => {
                  set({ soul: event.target.value })
                  touch('soul')
                }}
                placeholder={b.instructionsPlaceholder}
                value={state.soul}
              />
            </Field>
          </div>
        ) : (
          <SkillsPane
            b={b}
            filter={filter}
            onFilter={setFilter}
            onSkill={(skill, enabled) => {
              set({ skills: state.skills.map(row => (row.name === skill ? { ...row, enabled } : row)) })
              touch('skills')
            }}
            onToolset={(toolset, enabled) => {
              set({ toolsets: state.toolsets.map(row => (row.name === toolset ? { ...row, enabled } : row)) })
              touch('toolsets')
            }}
            skills={skills}
            toolsets={state.toolsets}
            totalSkills={state.skills.length}
          />
        )}
      </div>
    </DialogShell>
  )
}

function SkillsPane({
  b,
  filter,
  onFilter,
  onSkill,
  onToolset,
  skills,
  toolsets,
  totalSkills
}: {
  b: BotsText
  filter: string
  onFilter: (value: string) => void
  onSkill: (name: string, enabled: boolean) => void
  onToolset: (name: string, enabled: boolean) => void
  skills: SkillRow[]
  toolsets: ToolsetRow[]
  totalSkills: number
}) {
  return (
    <div className="grid gap-6">
      <section className="grid gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-(--text-primary)">{b.skillCount(totalSkills)}</h3>
          <SearchField containerClassName="w-48" onChange={onFilter} placeholder={b.skillsFilter} value={filter} />
        </div>
        <p className="text-xs leading-5 text-(--text-tertiary)">{b.skillsHelp}</p>
        <div className="max-h-64 overflow-y-auto rounded-(--radius-card) border border-(--border-default)">
          {skills.length ? (
            <ul className="divide-y divide-(--border-subtle)">
              {skills.map(skill => (
                <CheckRow
                  checked={skill.enabled}
                  description={skill.description}
                  key={skill.name}
                  label={skill.name}
                  onChange={enabled => onSkill(skill.name, enabled)}
                />
              ))}
            </ul>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-(--text-tertiary)">{b.skillsNone}</p>
          )}
        </div>
      </section>
      {toolsets.length ? (
        <section className="grid gap-2.5">
          <h3 className="text-sm font-medium text-(--text-primary)">{b.toolsLabel}</h3>
          <p className="text-xs leading-5 text-(--text-tertiary)">{b.toolsHelp}</p>
          <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {toolsets.map(toolset => (
              <CheckRow
                checked={toolset.enabled}
                description={toolset.description}
                key={toolset.name}
                label={toolset.name}
                onChange={enabled => onToolset(toolset.name, enabled)}
                plain
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function CheckRow({
  checked,
  description,
  label,
  onChange,
  plain = false
}: {
  checked: boolean
  description?: string
  label: string
  onChange: (value: boolean) => void
  plain?: boolean
}) {
  const id = useId()

  return (
    <li className={cn('flex items-start gap-2.5', plain ? 'py-1.5' : 'px-3 py-2')}>
      <Checkbox checked={checked} className="mt-0.5" id={id} onCheckedChange={value => onChange(value === true)} />
      <label className="grid min-w-0 cursor-pointer gap-0.5" htmlFor={id}>
        <span className="truncate text-sm text-(--text-primary)">{label}</span>
        {description ? <span className="line-clamp-1 text-xs text-(--text-tertiary)">{description}</span> : null}
      </label>
    </li>
  )
}
