// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { SkillInfo } from '@/types/hermes'

const validateSkillForHub = vi.fn()
const publishSkillToHub = vi.fn()
const proposeSkillToOrg = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  validateSkillForHub: (name: string, options: unknown) => validateSkillForHub(name, options),
  publishSkillToHub: (name: string, options: unknown) => publishSkillToHub(name, options),
  proposeSkillToOrg: (name: string, options: unknown) => proposeSkillToOrg(name, options)
}))

const SKILL: SkillInfo = { name: 'vneb-report', description: 'Reports', category: 'reports', enabled: true, provenance: 'agent' }

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
    result: { ok: true, package: { name: 'vneb-report', kind: 'core', version: '1.0.0', files: ['SKILL.md'], has_scripts: false, warnings: [] } }
  })
  publishSkillToHub.mockResolvedValue({ ok: true, status: 'ok', created: true, slug: 'vneb-report', visibility: 'org', version: '1.0.0', publish_state: 'scanning', scan_id: 's1', url: 'https://hub/skills/vneb-report', scan_url: 'https://hub/scans/s1' })
  proposeSkillToOrg.mockResolvedValue({ ok: true, status: 'ok', created: true, slug: 'vneb-report', visibility: 'org', version: '1.0.0', publish_state: 'published' })
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
      fireEvent.change(screen.getByTestId('publish-visibility'), { target: { value: 'org' } })
    })
    await waitFor(() => expect(validateSkillForHub).toHaveBeenCalledWith('vneb-report', { kind: undefined, visibility: 'org' }))
    await waitFor(() => expect((screen.getByTestId('publish-submit') as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })

    await waitFor(() => expect(publishSkillToHub).toHaveBeenCalledWith('vneb-report', { visibility: 'org', kind: undefined }))
    const done = await screen.findByTestId('publish-done')
    expect(done.textContent).toContain('Uploaded vneb-report@1.0.0')
    expect(done.textContent).toContain('Scanning · Organisation')
    expect(screen.getByRole('link', { name: 'View scan report' }).getAttribute('href')).toBe('https://hub/scans/s1')
  })

  it('proposing pins the visibility to the organisation', async () => {
    await renderDialog('propose')
    await screen.findByTestId('publish-preview-status')
    expect((screen.getByTestId('publish-visibility') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByTestId('publish-visibility') as HTMLSelectElement).value).toBe('org')

    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })

    await waitFor(() => expect(proposeSkillToOrg).toHaveBeenCalledWith('vneb-report', { kind: undefined }))
    expect((await screen.findByTestId('publish-done')).textContent).toContain('Published')
  })

  it('an invalid package cannot be uploaded and a hub refusal is translated', async () => {
    validateSkillForHub.mockResolvedValue({ ok: true, status: 'ok', result: { ok: false, error: { code: 'SKILL_INVALID|missing_name', message: 'needs a name', detail: null } } })
    await renderDialog('upload')
    expect((await screen.findByTestId('publish-preview-status')).textContent).toBe('Package is not valid yet')
    expect(screen.getByText('needs a name')).toBeTruthy()
    expect((screen.getByTestId('publish-submit') as HTMLButtonElement).disabled).toBe(true)

    validateSkillForHub.mockResolvedValue({ ok: true, status: 'ok', result: { ok: true, package: { name: 'vneb-report', kind: 'core', version: '1.0.0', files: ['SKILL.md'], has_scripts: false } } })
    publishSkillToHub.mockResolvedValue({ ok: false, status: 'error', code: 'version_not_newer', error_detail: { highest: '1.2.0' } })
    cleanup()
    await renderDialog('upload')
    await screen.findByTestId('publish-preview-status')
    await act(async () => {
      fireEvent.click(screen.getByTestId('publish-submit'))
    })
    expect((await screen.findByTestId('publish-error')).textContent).toContain('above 1.2.0')
  })
})
