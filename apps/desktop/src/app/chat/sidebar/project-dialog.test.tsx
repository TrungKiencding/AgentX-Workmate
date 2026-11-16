import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as Nanostores from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDialog, renameProjectOrAdopt } from '@/store/projects'

import { ProjectDialog } from './project-dialog'

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', save: 'Save' },
      sidebar: { projects: { renameFailed: 'Could not rename', renameTitle: 'Rename project' } }
    }
  })
}))

// A real atom so useStore behaves as in the app, without pulling in the rest
// of the projects store. vi.mock factories are hoisted, so the atom is made in
// vi.hoisted to exist by the time the factory runs.
const { $projectDialog } = vi.hoisted(() => {
  const { atom } = require('nanostores') as typeof Nanostores

  return {
    $projectDialog: atom<null | { adoptPath?: string; mode: 'rename'; name: string; projectId: string }>(null)
  }
})

vi.mock('@/store/projects', () => ({
  $projectDialog,
  closeProjectDialog: vi.fn(() => $projectDialog.set(null)),
  renameProjectOrAdopt: vi.fn(async () => undefined)
}))

const notifyError = vi.hoisted(() => vi.fn())

vi.mock('@/store/notifications', () => ({ notifyError }))

afterEach(() => {
  cleanup()
  $projectDialog.set(null)
  vi.mocked(renameProjectOrAdopt).mockReset()
  vi.mocked(renameProjectOrAdopt).mockResolvedValue(undefined)
  vi.mocked(closeProjectDialog).mockClear()
  notifyError.mockReset()
})

const nameField = () => screen.getByRole('textbox', { name: 'Rename project' }) as HTMLInputElement

describe('ProjectDialog (rename)', () => {
  it('stays closed until a rename is asked for', () => {
    render(<ProjectDialog />)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens on the current name and saves the new one', async () => {
    const state = { mode: 'rename' as const, name: 'Báo cáo', projectId: 'p_1' }
    $projectDialog.set(state)
    render(<ProjectDialog />)

    expect(nameField().value).toBe('Báo cáo')

    fireEvent.change(nameField(), { target: { value: 'Báo cáo quý 4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(renameProjectOrAdopt).toHaveBeenCalledWith(state, 'Báo cáo quý 4'))
    await waitFor(() => expect(closeProjectDialog).toHaveBeenCalled())
  })

  it('Enter submits; an auto project carries the folder it adopts', async () => {
    const state = { adoptPath: '/work/site', mode: 'rename' as const, name: 'site', projectId: '/work/site' }
    $projectDialog.set(state)
    render(<ProjectDialog />)

    fireEvent.change(nameField(), { target: { value: 'Website' } })
    fireEvent.submit(nameField().closest('form')!)

    await waitFor(() => expect(renameProjectOrAdopt).toHaveBeenCalledWith(state, 'Website'))
  })

  it('cannot save a blank name', () => {
    $projectDialog.set({ mode: 'rename', name: 'Old', projectId: 'p_1' })
    render(<ProjectDialog />)

    fireEvent.change(nameField(), { target: { value: '   ' } })

    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('closes without a write when the name did not change', async () => {
    $projectDialog.set({ mode: 'rename', name: 'Old', projectId: 'p_1' })
    render(<ProjectDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(closeProjectDialog).toHaveBeenCalled())
    expect(renameProjectOrAdopt).not.toHaveBeenCalled()
  })

  it('stays open and says so when the write fails', async () => {
    vi.mocked(renameProjectOrAdopt).mockRejectedValueOnce(new Error('boom'))
    $projectDialog.set({ mode: 'rename', name: 'Old', projectId: 'p_1' })
    render(<ProjectDialog />)

    fireEvent.change(nameField(), { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'Could not rename'))
    expect(closeProjectDialog).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
