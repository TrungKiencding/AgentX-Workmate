import { execFileSync } from 'node:child_process'

import { setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

/** Pair-only bridge processes started for this sandbox's AGENTX_HOME. */
function pairingProcesses(home: string): string[] {
  let out = ''

  try {
    out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
  } catch {
    return []
  }

  return out.split('\n').filter(line => line.includes('--pair-only') && line.includes(home))
}

// Runs the real backend + bundled WhatsApp bridge: the QR that appears is the
// one WhatsApp itself issued. Needs network (WhatsApp Web) and Node.js, like
// the feature does for a person.
test('WhatsApp links from a QR in the app, and cancelling ends the bridge run', async () => {
  test.setTimeout(240_000)
  const fixture = await setupMockBackend({ extraConfig: 'desktop:\n  repo_scan_enabled: false' })
  const { page } = fixture

  try {
    await waitForAppReady(fixture, 120_000)
    await page.evaluate(() => {
      window.location.hash = '/messaging?platform=whatsapp'
    })

    const guide = page.getByRole('region', { name: 'Connection guide' })
    await expect(guide).toBeVisible()
    // Step 1 of the coach is the phone link itself, not a terminal command.
    await expect(guide.getByRole('heading', { name: 'Link your phone' })).toBeVisible()
    await expect(page.getByText(/agentx whatsapp/)).toHaveCount(0)

    await guide.getByRole('button', { name: 'Show QR code', exact: true }).click()
    const qr = page.getByAltText('QR code to link WhatsApp with AgentX')
    await expect(qr).toBeVisible({ timeout: 150_000 })
    await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/)
    expect(pairingProcesses(fixture.sandbox.hermesHome)).toHaveLength(1)

    // The run survives moving from the coach to the full form…
    await guide.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(qr).toBeVisible()

    // …and cancelling stops the bridge instead of leaving it rotating codes.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Show QR code', exact: true })).toBeVisible()
    await expect.poll(() => pairingProcesses(fixture.sandbox.hermesHome), { timeout: 15_000 }).toHaveLength(0)
  } finally {
    await fixture.cleanup()
  }
})
