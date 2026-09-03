import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as Nanostores from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createProject, pickProjectFolder } from '@/store/projects'

import { ProjectDialog } from './project-dialog'

afterEach(() => {
  cleanup()
  vi.mocked(createProject).mockClear()
  vi.mocked(pickProjectFolder).mockReset()
  vi.mocked(pickProjectFolder).mockResolvedValue('/Users/test/my-folder')
})

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel', save: 'Save' },
      sidebar: {
        projects: {
          addFolder: 'Add folder',
          create: 'Create',
          createDesc: 'Create a new project',
          createFailed: 'Failed to create project',
          createTitle: 'New project',
          foldersLabel: 'Folders',
          ideaGenerate: 'Generate',
          ideaGenerating: 'Generating…',
          ideaLabel: 'Idea',
          ideaPlaceholder: 'What are you building?',
          ideaShuffle: 'Shuffle ideas',
          nameFromFolder: 'Named after the folder.',
          namePlaceholder: 'Project name',
          nameRequiredMulti: 'Several folders: give the project a name.',
          noFolders: 'No folders yet',
          primaryBadge: 'Primary',
          removeFolder: 'Remove folder'
        }
      }
    }
  })
}))

// $projectDialog is a real nanostore atom in the app; recreate it here so
// useStore behaves identically without pulling in the rest of the projects
// store (backend calls, project list, etc.) which is irrelevant to the Tip fix.
// vi.mock factories are hoisted above the rest of the file, so the atom must
// be created inside vi.hoisted to exist by the time the factory runs.
const { $projectDialog } = vi.hoisted(() => {
  const { atom } = require('nanostores') as typeof Nanostores

  return {
    $projectDialog: atom<{ mode: 'create' | 'rename' | 'add-folder'; name?: string; projectId?: string } | null>({
      mode: 'create'
    })
  }
})

vi.mock('@/store/projects', () => ({
  $projectDialog,
  addProjectFolder: vi.fn(),
  closeProjectDialog: vi.fn(),
  createProject: vi.fn(),
  generateProjectIdea: vi.fn(),
  pickProjectFolder: vi.fn(async () => '/Users/test/my-folder'),
  renameProject: vi.fn()
}))

vi.mock('@/store/notifications', () => ({
  notifyError: vi.fn()
}))

vi.mock('@/lib/project-idea-templates', () => ({
  randomIdeaTemplates: () => [{ emoji: '🚀', idea: 'A rocket tracker', label: 'Rocket tracker' }]
}))

const tipTrigger = (el: HTMLElement) => el.closest('[data-slot="tooltip-trigger"]')

// The name field is the first textbox in the dialog (the idea textarea is the
// other); its placeholder changes with the folder list, so it can't be the key.
const nameInput = () => screen.getAllByRole('textbox')[0] as HTMLInputElement
const createButton = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement

const addFolder = async (path: string) => {
  vi.mocked(pickProjectFolder).mockResolvedValueOnce(path)
  fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
  await screen.findByTitle(path)
}

describe('ProjectDialog', () => {
  it('wraps the "shuffle idea" button in a Tip', () => {
    render(<ProjectDialog />)

    const button = screen.getByRole('button', { name: 'Shuffle ideas' })
    expect(tipTrigger(button)).toBeTruthy()
  })

  it('wraps the "remove folder" button in a Tip once a folder is added', async () => {
    render(<ProjectDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))

    const button = await screen.findByRole('button', { name: 'Remove folder' })
    expect(tipTrigger(button)).toBeTruthy()
  })

  it('needs a folder before it can create anything', () => {
    render(<ProjectDialog />)

    expect(createButton().disabled).toBe(true)
    expect(nameInput().placeholder).toBe('Project name')
  })

  it('names a single-folder project after its folder, no typing required', async () => {
    render(<ProjectDialog />)

    await addFolder('/Users/test/Báo cáo quý 3/')

    expect(nameInput().value).toBe('Báo cáo quý 3')
    expect(screen.getByText('Named after the folder.')).toBeTruthy()
    expect(createButton().disabled).toBe(false)

    fireEvent.click(createButton())

    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1))
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ folders: ['/Users/test/Báo cáo quý 3/'], name: 'Báo cáo quý 3', use: true })
    )
  })

  it('still creates from the folder name when the suggested name is cleared', async () => {
    render(<ProjectDialog />)

    await addFolder('/Users/test/my-folder')
    fireEvent.change(nameInput(), { target: { value: '' } })

    // The field shows what the project would be called, and Create stays live.
    expect(nameInput().value).toBe('')
    expect(nameInput().placeholder).toBe('my-folder')
    expect(createButton().disabled).toBe(false)

    fireEvent.click(createButton())

    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-folder' })))
  })

  it('asks for a name once there are several folders', async () => {
    render(<ProjectDialog />)

    await addFolder('/Users/test/first')
    expect(nameInput().value).toBe('first')

    await addFolder('/Users/test/second')

    // The suggestion is withdrawn — two folders have no obvious name.
    expect(nameInput().value).toBe('')
    expect(screen.getByText('Several folders: give the project a name.')).toBeTruthy()
    expect(createButton().disabled).toBe(true)

    fireEvent.change(nameInput(), { target: { value: 'Ops' } })

    expect(screen.queryByText('Several folders: give the project a name.')).toBeNull()
    expect(createButton().disabled).toBe(false)

    fireEvent.click(createButton())

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({ folders: ['/Users/test/first', '/Users/test/second'], name: 'Ops' })
      )
    )
  })

  it('brings the suggestion back when the list drops to one folder again', async () => {
    render(<ProjectDialog />)

    await addFolder('/Users/test/first')
    await addFolder('/Users/test/second')
    expect(nameInput().value).toBe('')

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove folder' })[1])

    await waitFor(() => expect(nameInput().value).toBe('first'))
    expect(createButton().disabled).toBe(false)
  })

  it('never touches a name the person typed', async () => {
    render(<ProjectDialog />)

    fireEvent.change(nameInput(), { target: { value: 'Quarterly' } })

    await addFolder('/Users/test/first')
    expect(nameInput().value).toBe('Quarterly')
    expect(screen.queryByText('Named after the folder.')).toBeNull()

    await addFolder('/Users/test/second')
    expect(nameInput().value).toBe('Quarterly')
    expect(createButton().disabled).toBe(false)

    fireEvent.click(createButton())

    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'Quarterly' })))
  })
})
