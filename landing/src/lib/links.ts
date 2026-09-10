/**
 * Every off-page destination, in one place.
 *
 * Download buttons point at the Releases *page*, not at asset URLs: the current
 * tag (`v2026.9.9`) carries no attached binaries yet, and a button that 404s is
 * worse than one that lands on a list. Once `npm run dist:mac|win|linux` output
 * is uploaded, swap the three `download.*` values for the direct asset URLs —
 * electron-builder names them `AgentXWorkmate-<version>-<os>-<arch>.<ext>`
 * (see `apps/desktop/package.json` → `build.artifactName`). Nothing else in the
 * page needs to change.
 */

const REPO = 'https://github.com/TrungKiencding/AgentX-Workmate'

export const LINKS = {
  github: REPO,
  releases: `${REPO}/releases/latest`,
  discussions: `${REPO}/discussions`,
  issues: `${REPO}/issues`,
  docs: `${REPO}/tree/main/website/docs`,
  license: `${REPO}/blob/main/LICENSE`,
  skills: 'https://agentskills.io',

  download: {
    mac: `${REPO}/releases/latest`,
    win: `${REPO}/releases/latest`,
    linux: `${REPO}/releases/latest`
  }
} as const

/** The two install one-liners, verbatim from the project README. */
export const INSTALL = {
  unix: 'curl -fsSL https://raw.githubusercontent.com/TrungKiencding/AgentX-Workmate/main/scripts/install.sh | bash',
  windows: 'iex (irm https://raw.githubusercontent.com/TrungKiencding/AgentX-Workmate/main/scripts/install.ps1)'
} as const
