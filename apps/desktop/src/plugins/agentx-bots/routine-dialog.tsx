/** "New scheduled task": name, what to do, and when — read back as a sentence. */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  host,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea
} from '@agentx/plugin-sdk'
import { type ReactNode, useEffect, useId, useState } from 'react'

import { Field } from './agent-dialog'
import { useBots } from './i18n'
import {
  addRoutine,
  composeSchedule,
  defaultSchedule,
  formatClock,
  FREQUENCIES,
  hasControlChars,
  previewSchedule,
  repeatCount,
  type ScheduleState,
  type Unit,
  UNITS,
  type Weekday,
  WEEKDAYS
} from './routines'

const TIMES: readonly string[] = Array.from({ length: 48 }, (_, i) => formatClock(Math.floor(i / 2), (i % 2) * 30))

const digits = (value: string, max: number) => value.replace(/\D/g, '').slice(0, max)

function Choice<T extends string>({
  label,
  onChange,
  options,
  value,
  width = 'w-full'
}: {
  label: string
  onChange: (value: T) => void
  options: readonly { id: T; label: string }[]
  value: T
  width?: string
}) {
  return (
    <Select onValueChange={next => onChange(next as T)} value={value}>
      <SelectTrigger aria-label={label} className={width}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(option => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Inline({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)">{children}</div>
}

export function RoutineDialog({
  botLabel,
  onClose,
  open,
  profile
}: {
  botLabel: string
  onClose: () => void
  open: boolean
  profile: string
}) {
  const b = useBots()
  const ids = { name: useId(), task: useId() }
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [schedule, setSchedule] = useState<ScheduleState>(defaultSchedule)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTitle('')
      setInstruction('')
      setSchedule(defaultSchedule())
      setBusy(false)
      setError(null)
    }
  }, [open])

  const upd = (patch: Partial<ScheduleState>) => setSchedule(prev => ({ ...prev, ...patch }))
  const composed = composeSchedule(schedule)
  const canSubmit = Boolean(title.trim() && instruction.trim() && composed) && !busy
  const unitOptions = UNITS.map(id => ({ id, label: b.unit[id] }))

  const submit = async () => {
    if (!canSubmit) {
      return
    }

    if (hasControlChars(title, instruction)) {
      setError(b.routineInvalid)

      return
    }

    setBusy(true)
    setError(null)

    try {
      await addRoutine(profile, {
        instruction: instruction.trim(),
        repeat: repeatCount(schedule),
        schedule: composed,
        title: title.trim()
      })
      host.notify({ kind: 'success', message: b.routineCreated(title.trim()) })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const needsTime = ['daily', 'weekdays', 'weekly', 'monthly'].includes(schedule.freq)

  return (
    <Dialog onOpenChange={value => !value && !busy && onClose()} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{b.routineDialogTitle}</DialogTitle>
          <DialogDescription>{b.routineDialogDescription(botLabel)}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <Field htmlFor={ids.name} label={b.routineNameLabel}>
            <Input
              autoFocus
              id={ids.name}
              maxLength={120}
              onChange={event => setTitle(event.target.value)}
              placeholder={b.routineNamePlaceholder}
              value={title}
            />
          </Field>
          <Field htmlFor={ids.task} label={b.routineTaskLabel}>
            <Textarea
              className="min-h-24"
              id={ids.task}
              onChange={event => setInstruction(event.target.value)}
              placeholder={b.routineTaskPlaceholder}
              value={instruction}
            />
          </Field>
          <Field label={b.whenLabel}>
            <div className="grid gap-2.5 rounded-(--radius-card) bg-(--bg-subtle) p-3">
              <Inline>
                <Choice
                  label={b.whenLabel}
                  onChange={freq => upd({ freq })}
                  options={FREQUENCIES.map(id => ({ id, label: b.freq[id] }))}
                  value={schedule.freq}
                  width="w-52"
                />
                {schedule.freq === 'weekly' ? (
                  <Choice
                    label={b.freq.weekly}
                    onChange={(weekday: Weekday) => upd({ weekday })}
                    options={WEEKDAYS.map(id => ({ id, label: b.weekday[id] }))}
                    value={schedule.weekday}
                    width="w-36"
                  />
                ) : null}
                {schedule.freq === 'monthly' ? (
                  <>
                    <span>{b.onDay}</span>
                    <Input
                      aria-label={b.onDay}
                      className="w-16 text-center"
                      inputMode="numeric"
                      onChange={event => upd({ monthday: digits(event.target.value, 2) })}
                      value={schedule.monthday}
                    />
                  </>
                ) : null}
                {needsTime ? (
                  <>
                    <span>{b.atTime}</span>
                    <Choice
                      label={b.atTime}
                      onChange={time => upd({ time })}
                      options={TIMES.map(id => ({ id, label: id }))}
                      value={TIMES.includes(schedule.time) ? schedule.time : '08:00'}
                      width="w-28"
                    />
                  </>
                ) : null}
                {schedule.freq === 'interval' || schedule.freq === 'once' ? (
                  <>
                    <span>{schedule.freq === 'once' ? b.inLabel : b.everyLabel}</span>
                    <Input
                      aria-label={schedule.freq === 'once' ? b.inLabel : b.everyLabel}
                      className="w-20 text-center"
                      inputMode="numeric"
                      onChange={event =>
                        upd(
                          schedule.freq === 'once'
                            ? { onceN: digits(event.target.value, 4) }
                            : { intervalN: digits(event.target.value, 4) }
                        )
                      }
                      value={schedule.freq === 'once' ? schedule.onceN : schedule.intervalN}
                    />
                    <Choice
                      label={b.unit.h}
                      onChange={(unit: Unit) =>
                        upd(schedule.freq === 'once' ? { onceUnit: unit } : { intervalUnit: unit })
                      }
                      options={unitOptions}
                      value={schedule.freq === 'once' ? schedule.onceUnit : schedule.intervalUnit}
                      width="w-28"
                    />
                  </>
                ) : null}
              </Inline>
              {schedule.freq === 'advanced' ? (
                <Input
                  aria-label={b.freq.advanced}
                  className="font-mono"
                  onChange={event => upd({ raw: event.target.value })}
                  placeholder={b.advancedSchedulePlaceholder}
                  value={schedule.raw}
                />
              ) : null}
              {schedule.freq !== 'once' && schedule.freq !== 'advanced' ? (
                <Inline>
                  <span>{b.stopAfter}</span>
                  <Input
                    aria-label={b.stopAfter}
                    className="w-16 text-center"
                    inputMode="numeric"
                    onChange={event => upd({ repeatN: digits(event.target.value, 4) })}
                    placeholder="∞"
                    value={schedule.repeatN}
                  />
                  <span className="text-(--text-tertiary)">{b.stopAfterHelp}</span>
                </Inline>
              ) : null}
              {composed ? (
                <p aria-live="polite" className="text-sm font-medium text-(--text-primary)">
                  {previewSchedule(schedule, b)}
                </p>
              ) : null}
            </div>
          </Field>
          {error ? (
            <p className="text-sm text-(--danger)" role="alert">
              {error}
            </p>
          ) : null}
          <button className="hidden" disabled={!canSubmit} type="submit" />
        </form>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            {b.cancel}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? b.scheduling : b.scheduleCreate}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
