// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { SkillInfo } from '@/types/hermes'

const validateSkillForHub = vi.fn()
const publishSkillToHub = vi.fn()
const proposeSkillToWorkspace = vi.fn()
const getSkillHubChanges = vi.fn()
const bumpSkillVersion = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  validateSkillForHub: (name: string, options: unknown) => validateSkillForHub(name, options),
  publishSkillToHub: (name: string, options: unknown) => publishSkillToHub(name, options),
  proposeSkillToWorkspace: (name: string, options: unknown) => proposeSkillToWorkspace(name, options),
  getSkillHubChanges: () => getSkillHubChanges(),
  bumpSkillVersion: (name: string, version: string) => bumpSkillVersion(name, version)
}))

const SKILL: SkillInfo = {
  name: 'vneb-report',
  description: 'Reports',
  category: 'reports',
  enabled: true,
  provenance: 'agent'
}

async function renderDialog(mode: 'upload' | 'propose' = 'upload') {
  const { PublishSkillDialog } = await import('./publish-dialog')
  const onClose = vi.fn()
  await act(async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PublishSkillDialog mode={mode} onClose={onClose} open skill={SKILL} />
      </QueryClientProvider>
    )
  })

  return onClose
}

beforeEach(() => {
  validateSkillForHub.mockResolvedValue({
    ok: true,
    status: 'ok',
    files: ['SKILL.md'],
    result: {
      ok: true,
      package: {
        name: 'vneb-report',
        kind: 'core',
        version: '1.0.0',
        files: ['SKILL.md'],
        has_scripts: false,
        warnings: []
      }
    }
  })
  publishSkillToHub.mockResolvedValue({
    ok: true,
    status: 'ok',
    created: true,
    slug: 'vneb-report',
    visibility: 'workspace',
    workspace: 'doi-dev',
    version: '1.0.0',
    publish_state: 'scanning',
    scan_id: 's1',
    url: 'https://hub/skills/vneb-report',
    scan_url: 'https://hub/scans/s1'
  })
  proposeSkillToWorkspace.mockResolvedValue({
    ok: true,
    status: 'ok',
    created: true,
    slug: 'vneb-report',
    visibility: 'workspace',
    workspace: 'doi-dev',
    version: '1.0.0',
    publish_state: 'needs_review'
  })
  getSkillHubChanges.mockResolvedValue({
    workspaces: [
      { id: 'w1', slug: 'doi-dev', name: 'Đội Dev', role: 'member', skills: [] },
      { id: 'w2', slug: 'qa', name: 'QA', role: 'owner', skills: [] }
    ]
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PublishSkillDialog', () => {
  it('previews through the hub, uploads with the chosen visibility and shows where it went', async () => {
    await renderDialog('upload')

    expect((await screen.findByTestId('publish-preview-status')).textContent).toBe('Package is valid')
    expect(screen.getByTestId('publish-preview-name').textContent).toBe('vneb-report')
    expect(validateSkillForHub).toHaveBeenCalledWith('vneb-report', { kind: undefined, visibility: 'private' })

    await act(async () => {
      fireEvent.change(screen.getByTestId('publish-visibility'), { target: { value: 'workspace' } })
    })
    await waitFor(() =>
      expect(validateSkillForHub).toHaveBeenCalledWith('vneb-report', { kind: undefined, visibility: 'workspace' })
    )
    // The workspace picker appears with the person's workspaces; the second one is chosen.
    await waitFor(() => expect((screen.getByTestId('publish-workspace') as HTMLSelectElement).value).toBe('doi-dev'))
    await act(async () => {
      fireEvent.change(screen.getByTestId('publish-workspace'), { target: { value: 'qa' } })
    })
    await waitFor(() => expect((screen.getByTestId('publish-submit') as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })

    await waitFor(() =>
      expect(publishSkillToHub).toHaveBeenCalledWith('vneb-report', {
        visibility: 'workspace',
        workspace: 'qa',
        kind: undefined
      })
    )
    const done = await screen.findByTestId('publish-done')
    expect(done.textContent).toContain('Uploaded vneb-report@1.0.0')
    expect(done.textContent).toContain('Scanning · Workspace · doi-dev')
    expect(screen.getByRole('link', { name: 'View scan report' }).getAttribute('href')).toBe('https://hub/scans/s1')
  })

  it('sharing pins the visibility to a workspace and names the one chosen', async () => {
    await renderDialog('propose')
    await screen.findByTestId('publish-preview-status')
    expect((screen.getByTestId('publish-visibility') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByTestId('publish-visibility') as HTMLSelectElement).value).toBe('workspace')
    await waitFor(() => expect((screen.getByTestId('publish-workspace') as HTMLSelectElement).value).toBe('doi-dev'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })

    await waitFor(() =>
      expect(proposeSkillToWorkspace).toHaveBeenCalledWith('vneb-report', { workspace: 'doi-dev', kind: undefined })
    )
    expect((await screen.findByTestId('publish-done')).textContent).toContain('Needs review')
  })

  it('with no workspace to share into, the button stays off and says why', async () => {
    getSkillHubChanges.mockResolvedValue({ workspaces: [] })
    await renderDialog('propose')
    await screen.findByTestId('publish-preview-status')
    expect((await screen.findByTestId('publish-no-workspace')).textContent).toContain('not in any workspace')
    expect((screen.getByTestId('publish-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('an invalid package cannot be uploaded and a hub refusal is translated', async () => {
    validateSkillForHub.mockResolvedValue({
      ok: true,
      status: 'ok',
      result: { ok: false, error: { code: 'SKILL_INVALID|missing_name', message: 'needs a name', detail: null } }
    })
    await renderDialog('upload')
    expect((await screen.findByTestId('publish-preview-status')).textContent).toBe('Package is not valid yet')
    expect(screen.getByText('needs a name')).toBeTruthy()
    expect((screen.getByTestId('publish-submit') as HTMLButtonElement).disabled).toBe(true)

    validateSkillForHub.mockResolvedValue({
      ok: true,
      status: 'ok',
      result: {
        ok: true,
        package: { name: 'vneb-report', kind: 'core', version: '1.0.0', files: ['SKILL.md'], has_scripts: false }
      }
    })
    publishSkillToHub.mockResolvedValue({
      ok: false,
      status: 'error',
      code: 'version_not_newer',
      error_detail: { highest: '1.2.0' }
    })
    cleanup()
    await renderDialog('upload')
    await screen.findByTestId('publish-preview-status')
    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })
    expect((await screen.findByTestId('publish-error')).textContent).toContain('above 1.2.0')
    // An older hub names no number: nothing to offer but the sentence.
    expect(screen.queryByTestId('publish-bump')).toBeNull()
  })

  it('a refused version is one press away: the number the hub names goes into SKILL.md, then the upload runs again', async () => {
    publishSkillToHub
      .mockResolvedValueOnce({
        ok: false,
        status: 'error',
        code: 'version_exists',
        error_detail: { slug: 'vneb-report', version: '1.0.0', highest: '1.0.2', suggested_version: '1.0.3' }
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 'ok',
        created: true,
        slug: 'vneb-report',
        visibility: 'private',
        version: '1.0.3',
        publish_state: 'scanning'
      })
    bumpSkillVersion.mockResolvedValue({ ok: true, name: 'vneb-report', version: '1.0.3', changed: true })

    await renderDialog('upload')
    await screen.findByTestId('publish-preview-status')
    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })

    const bump = await screen.findByTestId('publish-bump')
    expect(bump.textContent).toBe('Bump to 1.0.3 and upload')
    await act(async () => {
      fireEvent.click(bump)
    })

    await waitFor(() => expect(screen.getByTestId('publish-done').textContent).toContain('1.0.3'))
    expect(bumpSkillVersion).toHaveBeenCalledWith('vneb-report', '1.0.3')
    expect(publishSkillToHub).toHaveBeenCalledTimes(2)
    // The preview reads SKILL.md again, now at the new number.
    expect(validateSkillForHub.mock.calls.length).toBeGreaterThan(1)
  })

  it('a bump the backend refuses is shown, and nothing is uploaded again', async () => {
    publishSkillToHub.mockResolvedValue({
      ok: false,
      status: 'error',
      code: 'version_not_newer',
      error_detail: { highest: '1.2.0', suggested_version: '1.2.1' }
    })
    bumpSkillVersion.mockRejectedValue(new Error('Skill not found'))

    await renderDialog('upload')
    await screen.findByTestId('publish-preview-status')
    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })
    await act(async () => {
      fireEvent.click(await screen.findByTestId('publish-bump'))
    })

    await waitFor(() => expect(screen.getByTestId('publish-error').textContent).toContain('Skill not found'))
    expect(publishSkillToHub).toHaveBeenCalledTimes(1)
  })
})
