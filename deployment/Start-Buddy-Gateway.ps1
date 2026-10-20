param(
  [Parameter(Mandatory=$true)][string]$ServerSha256,
  [Parameter(Mandatory=$true)][string]$AdapterSha256,
  [Parameter(Mandatory=$true)][string]$ConfigSha256,
  [Parameter(Mandatory=$true)]$ProtocolHashes,
  [Parameter(Mandatory=$true)][string]$UsageSha256,
  [Parameter(Mandatory=$false)][string]$ApiKeysSha256
)
. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
Assert-BuddyGuards
Assert-BuddyRoot
$server = Join-Path $BuddyRoot 'server.mjs'
Assert-BuddyHash $server $ServerSha256
Assert-BuddyHash (Join-Path $BuddyRoot 'adapter.mjs') $AdapterSha256
Assert-BuddyHash (Join-Path $BuddyRoot 'config.json') $ConfigSha256
# usage.mjs is imported by server.mjs, so it is pinned separately from the three
# protocol modules (whose count the manifest guard still enforces).
Assert-BuddyHash (Join-Path $BuddyRoot 'usage.mjs') $UsageSha256
# apikeys.mjs is imported by server.mjs for dashboard-created credentials; it is
# pinned when the manifest carries its hash so an edit cannot silently widen auth.
if ($ApiKeysSha256) { Assert-BuddyHash (Join-Path $BuddyRoot 'apikeys.mjs') $ApiKeysSha256 }
if (@($ProtocolHashes.PSObject.Properties).Count -ne 3) { throw 'Protocol integrity manifest is incomplete.' }
foreach ($moduleName in @('protocol-common.mjs','messages.mjs','responses.mjs')) {
  Assert-BuddyHash (Join-Path $BuddyRoot $moduleName) $ProtocolHashes.$moduleName
}
$statePath = Join-Path $BuddyRoot 'run\gateway.json'
$existing = Get-BuddyOwnedProcess $statePath $server
if ($existing) { [pscustomobject]@{Role='gateway';ProcessId=$existing.ProcessId;AlreadyRunning=$true}; return }
if (Get-NetTCPConnection -State Listen -LocalPort 3190 -ErrorAction SilentlyContinue) { throw 'Port3190 already belongs to an untracked listener; do not stop or replace it.' }
if (-not (Test-Path -LiteralPath $BuddyNode -PathType Leaf)) { throw 'Node executable missing.' }
$paths = New-BuddyRunPaths 'gateway'
# Pin only this gateway child; preserve an explicit caller configuration.
$workBuddyEnvName = 'WORKBUDDY_AI_ELECTRON_BIN'
$previousWorkBuddyBin = [Environment]::GetEnvironmentVariable($workBuddyEnvName,'Process')
# Only needed for desktop capture; a deployment that signs in through the web
# flow does not have to install the app.
$workBuddyBin = if (-not [string]::IsNullOrWhiteSpace($previousWorkBuddyBin)) {
  $previousWorkBuddyBin.Trim()
} else {
  Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddyAI\WorkBuddyAI.exe'
}
$hasWorkBuddyBin = [IO.Path]::IsPathRooted($workBuddyBin) -and (Test-Path -LiteralPath $workBuddyBin -PathType Leaf)
try {
  if ($hasWorkBuddyBin) { [Environment]::SetEnvironmentVariable($workBuddyEnvName,$workBuddyBin,'Process') }
  $process = Start-Process -FilePath $BuddyNode -ArgumentList @('"'+$server+'"') -WorkingDirectory $BuddyRoot -WindowStyle Hidden -RedirectStandardOutput $paths.Out -RedirectStandardError $paths.Err -PassThru
} finally {
  [Environment]::SetEnvironmentVariable($workBuddyEnvName,$previousWorkBuddyBin,'Process')
}
$state = Write-BuddyProcessState $process 'gateway' $server $paths $ServerSha256
[pscustomobject]@{Role='gateway';ProcessId=$state.ProcessId;StartTimeUtc=$state.StartTimeUtc;StateFile=$paths.State}
