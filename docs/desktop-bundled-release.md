# Desktop runtime release migration

The production `com.agentx.workmate` installer ships `resources/bundled-runtime`.
`beforePack` stages standalone CPython, frozen/hash-verified Python dependencies,
tracked backend/plugin/skill source, Node, uv, agent-browser, and Windows Git/Bash.
The shipped Node is pinned to 22.23.3 LTS independently of the builder's Node;
native load commands are checked against the app's macOS 12 minimum so updating
a build machine cannot silently drop support for existing users.
A production payload is version/commit/OS/architecture checked and never falls
back to downloading source. The two currently distributed builds are macOS
ARM64 and Windows x64; each must be built on its native OS/architecture.
Other architecture targets fail explicitly until their runtime is verified.
Isolated Runtime Preview builds retain their separate identity and homes.

## Existing users

Keep the official app ID, product name, executable and Electron userData path.
Keep `resolveHermesHome`'s existing account/profile, registry and legacy-home
resolution. Select the bundled backend before a managed checkout, without
moving or deleting the old checkout. User config, .env, sessions, memory,
skills/plugins, profiles and native OAuth token store remain in the same home.
Optional Python SDKs live outside the immutable app in a Python/OS/arch-scoped
cache. The code-scoped `.install_method=bundled` prevents CLI/dashboard source
updaters from modifying the signed app or trusting a legacy home git marker.

1. macOS desktop 1.0.10 checks the unchanged signed landing-page feed and
   replaces the whole bundle with 1.1.0 using its existing platform handoff.
   Published Windows 1.0.10 still has the tasklist/findstr pipeline deadlock;
   Windows 1.0.x users must run the new installer over the existing copy once.
   The corrected helper ships in 1.1.0 for later updates, using the same NSIS
   identity and `--updated /S --force-run`. A new feed cannot patch an old binary.
2. Older builds without the app updater, or a failing historical handoff, use
   the download page. Install over the old copy; do not uninstall first.
3. Windows uninstallers before 1.0.9 defaulted to deleting user data. Avoid
   invoking them independently. An update skips custom purge via `${isUpdated}`.
4. Keep GitHub public during rollout for users still installing/repairing the
   old source-based releases and for standalone CLI source updates. The new
   desktop runtime has no dependency on public access to the source repository.
   This migration does not change repository visibility.

## Publishing

Run Release Desktop on the release branch for native builders and CI evidence.
Download authenticated workflow artifacts as the release operator; no GitHub
credential is embedded in the app. GitHub can hold private build artifacts.

For local native macOS: `npm run dist:mac:dmg` from `apps/desktop`.
For native Windows: `npm run dist:win:nsis -- --x64`.
The install stamp must be clean. The Mac payload and hash-bound Windows CI
manifest must agree with the release version and source commit.

Put both verified installers under the names the release feed expects in a
staging folder, with `AgentXWorkmate-<version>-win-build.json` from Windows CI.
Use `npm run release:feed -- build --release-dir <staging> --out <site>/public/install`.
The existing Ed25519 key stays on the release machine, outside the repository.
The signing command rejects preview, incomplete and mismatched payloads.

The signed `/install/release.json` names immutable
`/install/<version>/AgentXWorkmate-<platform>-<arch>.<ext>` URLs. Root aliases
remain for the download page. Republishing different bytes under an existing
version is rejected. Site deployment checks all upload hashes, keeps versioned
installers referenced by older feeds, atomically switches the site and rolls
back if the live signed feed does not match. Keep the previous release for
rollback; signing an older version does not force clients to downgrade.

## Validation before switching the live feed

- Unit tests: relocation, native architecture/version/commit matching,
  outside-app optional packages, signatures/checksums and immutable URLs.
- macOS: actual relocated DMG app and backend; fresh sign-in gate; real gateway
  and terminal calls; restart retains data; production updater enabled.
- macOS upgrade: published 1.0.10 app through its actual updater IPC, real
  Keychain encryption with synthetic credentials and actual SessionDB history.
- Windows CI: run the 1.1.0 NSIS directly over published archived 1.0.10, with
  no outer update flag; check native login, data and restart, then offline startup.
  The separate `verify-windows-bundled-release.ps1 -CorrectedHandoff` mode takes
  the published old installer through actual check/download
  IPC, then its defective historical handoff explicitly replaced with the
  current production generator and a real wait process. Native NSIS replacement,
  native safeStorage credentials, data/hash preservation,
  then actual bundled gateway with external IPv4/IPv6 blocked and no developer
  tools on PATH. Checks include new install and retained old history.
- Verify signed feed and downloaded installer SHA256/size from the live domain.

Archived 1.0.10 installers used by repeatable CI live under `/install/1.0.10/`;
their hashes are fixed by the upgrade verification script.
