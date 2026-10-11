# Native CI only: published old installer -> real update IPC -> bundled production app.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = (Get-Content apps/desktop/package.json -Raw | ConvertFrom-Json).version
$state = Join-Path $env:RUNNER_TEMP 'windows-release-upgrade'
$legacy = Join-Path $state 'legacy-plugins'
New-Item -ItemType Directory -Force $legacy | Out-Null
$oldInstaller = Join-Path $env:RUNNER_TEMP 'workmate-1.0.10.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://agentx-landingpage.astralx.com.vn/install/1.0.10/AgentXWorkmate-win-x64.exe' -OutFile $oldInstaller
if ((Get-FileHash $oldInstaller -Algorithm SHA256).Hash -ne '2b9462115ea6b7830eeb4cc6f772eeddf9adbf6494ebfd359a4bb3bdffff4843') { throw 'Old installer changed; use the archived 1.0.10 fixture' }
$destination = Join-Path $env:RUNNER_TEMP 'workmate-production-installed'
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
# The published 1.0.10 cmd pipeline can deadlock. Its real IPC still checks,
# downloads and verifies the new installer, but cannot repair its own helper.
# After it quits, exercise the release's corrected production helper with a
# real wait process and the actual NSIS in-place replacement. This is recorded
# as a replaced historical handoff, never as a working 1.0.10 automatic update.
node apps/desktop/scripts/test-windows-update-ipc.mjs $exe $newInstaller $state --old-version=1.0.10 "--new-version=$version" --patched-handoff
if ($LASTEXITCODE -ne 0) { throw 'Corrected native installer handoff failed' }
node apps/desktop/scripts/test-windows-upgrade-state.mjs after $exe $state
if ($LASTEXITCODE -ne 0) { throw 'Update lost login or data' }
node apps/desktop/scripts/test-windows-upgrade-state.mjs restart $exe $state
if ($LASTEXITCODE -ne 0) { throw 'Restart lost login or data' }
node apps/desktop/scripts/test-windows-runtime-preview.mjs $exe (Join-Path $env:RUNNER_TEMP 'release-fresh') --production
if ($LASTEXITCODE -ne 0) { throw 'Fresh offline production startup failed' }
node apps/desktop/scripts/test-windows-runtime-preview.mjs $exe (Join-Path $env:RUNNER_TEMP 'release-migrated') (Join-Path $state 'agent-data') --production
if ($LASTEXITCODE -ne 0) { throw 'Real gateway lost old history or fetched a backend' }
