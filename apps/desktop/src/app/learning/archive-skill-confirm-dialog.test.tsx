import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_LOCALE, setRuntimeI18nLocale } from '@/i18n'
import { $notifications, resetNotifications } from '@/store/notifications'

import { ArchiveSkillConfirmDialog } from './archive-skill-confirm-dialog'

// The capabilities page and the memory graph's "Archive skill" item share this
// confirm, so its copy has to follow the app's language like the rest of both.

const archived: unknown[] = []

beforeEach(() => {
  archived.length = 0

  vi.stubGlobal('agentxDesktop', {
    api: vi.fn(async (request: { body?: unknown; method?: string; path: string }) => {
      if (request.method === 'DELETE' && request.path === '/api/learning/node') {
        archived.push(request.body)

        return { message: 'archived skill pdf-tools', ok: true }
      }

      throw new Error(`unexpected ${request.method ?? 'GET'} ${request.path}`)
    })
  })
})

afterEach(() => {
  cleanup()
  resetNotifications()
  setRuntimeI18nLocale(FALLBACK_LOCALE)
  vi.unstubAllGlobals()
})

function openDialog() {
  render(
    <ArchiveSkillConfirmDialog
      onApply={() => () => {}}
      onClose={() => {}}
      open
      skillId="skill:pdf-tools"
      skillName="pdf-tools"
    />
  )

  return screen.getByRole('dialog')
}

describe('ArchiveSkillConfirmDialog', () => {
  it('names the skill, says how to restore it, and archives on confirm', async () => {
    const dialog = openDialog()

    expect(within(dialog).getByText('Archive pdf-tools?')).toBeTruthy()
    expect(
      within(dialog).getByText('The skill is archived and can be restored with `agentx curator restore`.')
    ).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(archived).toEqual([{ id: 'skill:pdf-tools' }]))
    await waitFor(() => expect($notifications.get()[0]).toMatchObject({ kind: 'success', title: 'Skill archived' }))
  })

  it('speaks the active locale', async () => {
    setRuntimeI18nLocale('vi')
    const dialog = openDialog()

    expect(within(dialog).getByText('Lưu trữ pdf-tools?')).toBeTruthy()
    expect(
      within(dialog).getByText('Kỹ năng sẽ được lưu trữ và có thể khôi phục bằng lệnh `agentx curator restore`.')
    ).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu trữ' }))

    await waitFor(() => expect(archived).toEqual([{ id: 'skill:pdf-tools' }]))
    await waitFor(() => expect($notifications.get()[0]).toMatchObject({ kind: 'success', title: 'Đã lưu trữ kỹ năng' }))
  })
})
