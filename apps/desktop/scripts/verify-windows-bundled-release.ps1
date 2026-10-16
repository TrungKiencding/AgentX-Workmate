# Native CI only: published old installer -> native NSIS migration -> bundled app.
param(
  [switch]$CorrectedHandoff,
  [string]$PreviousVersion = '1.0.10',
  [string]$PreviousInstallerUrl = 'https://agentx-landingpage.astralx.com.vn/install/1.0.10/AgentXWorkmate-win-x64.exe',
  [string]$PreviousSha256 = '2b9462115ea6b7830eeb4cc6f772eeddf9adbf6494ebfd359a4bb3bdffff4843'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version
if ($PreviousVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid previous version' }
if ($PreviousInstallerUrl -notmatch '^https://') { throw 'Previous installer must use HTTPS' }
if ($PreviousSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid previous installer hash' }
$state = Join-Path $env:RUNNER_TEMP "windows-release-upgrade-$PreviousVersion"
$legacy = Join-Path $state 'legacy-plugins'
New-Item -ItemType Directory -Force $legacy | Out-Null
# NSIS must inherit the same real user home as the Electron fixtures; otherwise
# a destructive uninstaller could touch another directory and escape the check.
$env:AGENTX_HOME = Join-Path $state 'agent-data'
$env:AGENTX_DESKTOP_USER_DATA_DIR = Join-Path $state 'desktop-data'
$oldInstaller = Join-Path $env:RUNNER_TEMP "workmate-$PreviousVersion.exe"
Invoke-WebRequest -UseBasicParsing -Uri $PreviousInstallerUrl -OutFile $oldInstaller
if ((Get-FileHash $oldInstaller -Algorithm SHA256).Hash -ne $PreviousSha256) { throw 'Old installer changed; use the hash-pinned archived fixture' }
$destination = Join-Path $env:RUNNER_TEMP "workmate-production-installed-$PreviousVersion"
$p = Start-Process $oldInstaller -ArgumentList '/S', "/D=$destination" -PassThru
if (-not $p.WaitForExit(300000) -or $p.ExitCode -ne 0) { throw 'Old installer failed' }
$exe = Join-Path $destination 'AgentX Workmate.exe'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# User plugin bytes, memory, environment and real SessionDB are seeded and checked.
New-Item -ItemType Directory -Force (Join-Path $legacy 'user-example') | Out-Null
Set-Content (Join-Path $legacy 'user-example/plugin.yaml') 'name: user-example'
node apps/desktop/scripts/test-windows-upgrade-state.mjs before $exe $state
if ($LASTEXITCODE -ne 0) { throw 'Old credentials fixture failed' }
$newInstaller = Resolve-Path "apps/desktop/release/AgentXWorkmate-$version-win-x64.exe"
if ($CorrectedHandoff) {
  # Reproduce the published old IPC without modifying its historical binary,
  # then exercise the corrected production helper. The old helper cannot repair
  # itself; this mode is separate from the manual migration recommended to users.
  node apps/desktop/scripts/test-windows-update-ipc.mjs $exe $newInstaller $state "--old-version=$PreviousVersion" "--new-version=$version" --patched-handoff
  if ($LASTEXITCODE -ne 0) { throw 'Corrected native installer handoff failed' }
} else {
  # Recommended one-time migration: run the actual new installer directly over
  # the published old app, without an updater or an outer --updated flag.
  # /S only automates the installer pages on this disposable runner.
  $fixture = Get-Content (Join-Path $state 'synthetic-state.json') -Raw | ConvertFrom-Json
  $env:AGENTX_DESKTOP_APP_NAME = $fixture.appName
  $env:AGENTX_DESKTOP_BOOT_FAKE = '1'
  if ((Get-Item $exe).VersionInfo.ProductVersion -ne "$PreviousVersion.0") { throw 'Manual upgrade did not start from the requested old app' }
  $p = Start-Process $newInstaller -ArgumentList '/S', "/D=$destination" -PassThru
  if (-not $p.WaitForExit(300000) -or $p.ExitCode -ne 0) { throw 'Manual in-place installer failed' }
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
node apps/desktop/scripts/test-windows-upgrade-state.mjs after $exe $state
if ($LASTEXITCODE -ne 0) { throw 'Update lost login or data' }
node apps/desktop/scripts/test-windows-upgrade-state.mjs restart $exe $state
if ($LASTEXITCODE -ne 0) { throw 'Restart lost login or data' }
if (-not $CorrectedHandoff) {
  Copy-Item (Join-Path $state 'after-report.json') (Join-Path $state 'manual-report.json')
  Copy-Item (Join-Path $state 'restart-report.json') (Join-Path $state 'manual-restart-report.json')
}
node apps/desktop/scripts/test-windows-runtime-preview.mjs $exe (Join-Path $env:RUNNER_TEMP "release-fresh-$PreviousVersion") --production
if ($LASTEXITCODE -ne 0) { throw 'Fresh offline production startup failed' }
node apps/desktop/scripts/test-windows-runtime-preview.mjs $exe (Join-Path $env:RUNNER_TEMP "release-migrated-$PreviousVersion") (Join-Path $state 'agent-data') --production
if ($LASTEXITCODE -ne 0) { throw 'Real gateway lost old history or fetched a backend' }
