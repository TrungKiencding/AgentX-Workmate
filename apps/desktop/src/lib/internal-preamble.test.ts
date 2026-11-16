import { describe, expect, it } from 'vitest'

import { CRON_HINT_PREFIX, isCronPrompt, MODEL_SWITCH_MARKER_PREFIX, stripInternalPreamble } from './internal-preamble'

// The hint exactly as cron/scheduler.py builds it.
const HINT =
  `${CRON_HINT_PREFIX}DELIVERY: Your final response will be automatically delivered ` +
  'to the user — do NOT use send_message or try to deliver the output yourself. Just produce your ' +
  'report/output as your final response and the system handles the rest. SILENT: If there is genuinely ' +
  'nothing new to report, respond with exactly "[SILENT]" (nothing else) to suppress delivery. Never ' +
  'combine [SILENT] with content — either report your findings normally, or say [SILENT] and nothing more.]\n\n'

describe('stripInternalPreamble', () => {
  it('leaves exactly the task of a cron prompt', () => {
    expect(stripInternalPreamble(`${HINT}Tóm tắt tin tài chính hôm nay`)).toBe('Tóm tắt tin tài chính hôm nay')
  })

  it('keeps a task that itself has brackets and blank lines', () => {
    const task = 'Bước 1 [quan trọng]\n\nBước 2 ]\n\n hết'

    expect(stripInternalPreamble(HINT + task)).toBe(task)
  })

  it('strips a preview that was flattened to one line', () => {
    const flat = `${HINT}Tóm tắt tin tài chính`.replace(/\s+/g, ' ')

    expect(stripInternalPreamble(flat)).toBe('Tóm tắt tin tài chính')
  })

  it('yields nothing for a preview cut off inside the hint', () => {
    expect(stripInternalPreamble(`${CRON_HINT_PREFIX}DELIVER...`)).toBe('')
  })

  it('treats a model-switch marker as no message', () => {
    expect(stripInternalPreamble(`${MODEL_SWITCH_MARKER_PREFIX}deepseek-v4.1-flash. From this point…]`)).toBe('')
  })

  it('leaves what a person wrote untouched', () => {
    for (const text of ['Xin chào', '[IMPORTANT] đọc kỹ nhé', '  thụt đầu dòng', '']) {
      expect(stripInternalPreamble(text)).toBe(text)
    }

    expect(stripInternalPreamble(null)).toBe('')
  })
})

describe('isCronPrompt', () => {
  it('recognises the scheduler, not a person quoting it', () => {
    expect(isCronPrompt(`${HINT}task`)).toBe(true)
    expect(isCronPrompt('Tại sao có dòng "You are running as a scheduled cron job"?')).toBe(false)
    expect(isCronPrompt(undefined)).toBe(false)
  })
})
