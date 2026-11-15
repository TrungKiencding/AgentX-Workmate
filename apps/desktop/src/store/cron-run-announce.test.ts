import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { translateNow } from '@/i18n'
import { resetRunAnnouncements, RUN_EXCERPT_MAX } from '@/lib/cron-runs'
import type { CronJob } from '@/types/hermes'

import { $cronFocusJobId, $cronJobs, $cronReviewRequest, resetCronRunTracking, setCronJobs } from './cron'
import { dispatchNativeNotification } from './native-notifications'
import { $notifications, clearNotifications } from './notifications'

vi.mock('./native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))

const NOW = Date.parse('2026-11-10T21:00:30+07:00')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const job = (over: Partial<CronJob>): CronJob => ({ enabled: true, id: 'j1', name: 'Bản tin tài chính', ...over })

// Pilot 2026-11: a scheduled task ran (or failed) and nothing on screen said so.
describe('a scheduled run is announced', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetCronRunTracking()
    resetRunAnnouncements()
    clearNotifications()
    $cronJobs.set([])
    vi.mocked(dispatchNativeNotification).mockClear()
  })

  afterEach(() => {
    clearNotifications()
    vi.useRealTimers()
  })

  it('says nothing for the list the app starts with', () => {
    setCronJobs([job({ last_run_at: ago(1_000), last_status: 'ok' })])

    expect($notifications.get()).toEqual([])
    expect(dispatchNativeNotification).not.toHaveBeenCalled()
    expect($cronJobs.get()).toHaveLength(1)
  })

  it('toasts and notifies the OS when a known job has just run', () => {
    setCronJobs([job({ last_run_at: ago(86_400_000), last_status: 'ok' })])
    setCronJobs([job({ last_run_at: ago(1_000), last_status: 'ok' })])

    const [toast] = $notifications.get()

    expect(toast.kind).toBe('success')
    expect(toast.title).toContain('Bản tin tài chính')
    expect(dispatchNativeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ global: true, kind: 'backgroundDone', tag: 'cron:j1' })
    )

    // The action opens the schedule on that job.
    const before = $cronReviewRequest.get()

    toast.action?.onClick()
    expect($cronFocusJobId.get()).toBe('j1')
    expect($cronReviewRequest.get()).toBe(before + 1)
  })

  // 2026-11: a reminder made in a chat ("Nhắc tôi lúc 20:30…") has no chat to
  // be delivered into, so this announcement is the reminder. It said only
  // "Kết quả đã sẵn sàng." and hid the reminder itself behind "Xem".
  it('shows what the run said, in the toast and in the OS notification', () => {
    const said = '⏰ 20:30 rồi — đến giờ họp nhóm dự án.'

    setCronJobs([job({ last_run_at: null, name: 'Nhắc họp nhóm' })])
    setCronJobs([job({ last_output_preview: said, last_run_at: ago(500), last_status: 'ok', name: 'Nhắc họp nhóm' })])

    const [toast] = $notifications.get()

    expect(toast.kind).toBe('success')
    expect(toast.message).toBe(said)
    expect(dispatchNativeNotification).toHaveBeenCalledWith(expect.objectContaining({ body: said, tag: 'cron:j1' }))
  })

  // A reminder that fades after six seconds is missed by anyone who was looking
  // at another window: the toast that carries the words waits to be closed.
  it('keeps a toast that carries the run’s words until it is dismissed', () => {
    setCronJobs([job({ last_run_at: null })])
    setCronJobs([job({ last_output_preview: 'Đến giờ uống nước rồi!', last_run_at: ago(500), last_status: 'ok' })])

    vi.advanceTimersByTime(60_000)

    expect($notifications.get().map(toast => toast.message)).toEqual(['Đến giờ uống nước rồi!'])
  })

  it('still lets the generic line time out', () => {
    setCronJobs([job({ last_run_at: null })])
    setCronJobs([job({ last_run_at: ago(500), last_status: 'ok' })])

    expect($notifications.get()).toHaveLength(1)
    vi.advanceTimersByTime(60_000)

    expect($notifications.get()).toEqual([])
  })

  it('keeps the generic line when the run left nothing to show', () => {
    setCronJobs([job({ last_run_at: null })])
    setCronJobs([job({ last_output_preview: '  \n ', last_run_at: ago(500), last_status: 'ok' })])

    const [toast] = $notifications.get()

    expect(toast.message).toBe(translateNow('cron.runDoneBody'))
    expect(dispatchNativeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: translateNow('cron.runDoneBody') })
    )
  })

  it('keeps a long result to a few lines of one paragraph', () => {
    const long = `Bản tin sáng:\n\n${'VN-Index tăng nhẹ trong phiên. '.repeat(40)}`

    setCronJobs([job({ last_run_at: null })])
    setCronJobs([job({ last_output_preview: long, last_run_at: ago(500), last_status: 'ok' })])

    const { message } = $notifications.get()[0]

    expect(message.startsWith('Bản tin sáng: VN-Index tăng nhẹ')).toBe(true)
    expect(message).not.toContain('\n')
    expect(message.length).toBeLessThanOrEqual(RUN_EXCERPT_MAX)
    expect(message.endsWith('…')).toBe(true)
  })

  it('never shows the words of a run that failed', () => {
    setCronJobs([job({ last_run_at: null })])
    setCronJobs([
      job({
        last_error: 'HTTP 429',
        last_output_preview: 'HTTP 429 quota exceeded for key',
        last_run_at: ago(500),
        last_status: 'error'
      })
    ])

    const [toast] = $notifications.get()

    expect(toast.kind).toBe('error')
    expect(toast.message).toBe(translateNow('cron.runFailedBody'))
    expect(dispatchNativeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ body: translateNow('cron.runFailedBody') })
    )
  })

  it('reports a failed run as an error', () => {
    setCronJobs([job({ last_run_at: null })])
    setCronJobs([job({ last_error: 'HTTP 429', last_run_at: ago(500), last_status: 'error' })])

    const [toast] = $notifications.get()

    expect(toast.kind).toBe('error')
    // The raw diagnostic is not what the person is shown.
    expect(`${toast.title} ${toast.message}`).not.toContain('429')
  })

  it('announces one run once, however often the list is re-read', () => {
    setCronJobs([job({ last_run_at: null })])

    const ran = [job({ last_run_at: ago(500), last_status: 'ok' })]

    setCronJobs(ran)
    setCronJobs(ran)
    setCronJobs(ran)

    expect(dispatchNativeNotification).toHaveBeenCalledTimes(1)
    expect($notifications.get()).toHaveLength(1)
  })

  it('names a job that has no name', () => {
    setCronJobs([job({ last_run_at: null, name: '' })])
    setCronJobs([job({ last_run_at: ago(500), last_status: 'ok', name: '' })])

    expect($notifications.get()[0].title).toBeTruthy()
  })
})
