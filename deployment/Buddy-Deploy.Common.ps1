$ErrorActionPreference = 'Stop'
$BuddyRoot = if ($env:BUDDY_ROOT) { $env:BUDDY_ROOT } else { Split-Path -Parent $PSScriptRoot }
$BuddyNode = if ($env:BUDDY_NODE) { $env:BUDDY_NODE } else { (Get-Command node.exe -ErrorAction Stop).Source }
$BuddyCloudflared = if ($env:BUDDY_CLOUDFLARED) { $env:BUDDY_CLOUDFLARED } else { 'cloudflared.exe' }
$BuddyTaskName = 'TLPRO Buddy API'

function Assert-BuddyGuards {
  # Optional: guard other services' configs against accidental edits. Empty by
  # default so a fresh clone has nothing to compare; set BUDDY_GUARDS to a JSON
  # array of { path, hash } to enable it.
  $guards = @()
  if ($env:BUDDY_GUARDS) {
    try { $guards = $env:BUDDY_GUARDS | ConvertFrom-Json } catch { throw 'BUDDY_GUARDS is not valid JSON.' }
  }
  foreach ($guard in $guards) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $guard.path).Hash.ToLowerInvariant() -ne $guard.hash) { throw 'Guarded configuration changed; stop and compare.' }
  }
}
function Assert-BuddyChildPath([string]$Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  if (-not $absolute.StartsWith($BuddyRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Buddy path escaped dedicated service root.' }
  return $absolute
}
function Assert-BuddyHash([string]$Path,[string]$Expected) {
  if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Expected SHA256 missing or invalid.' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Expected) { throw 'Buddy artifact hash changed; stop and compare.' }
}
function Assert-BuddyRoot {
  if (-not (Test-Path -LiteralPath $BuddyRoot -PathType Container)) { throw 'Root must install the dedicated Buddy service first.' }
  $config = Get-Content -LiteralPath (Join-Path $BuddyRoot 'config.json') -Raw | ConvertFrom-Json
  if ($config.port -ne 3190 -or $config.apiKeyFile -ne 'secrets/api-key.txt' -or $config.dataDir -ne 'data') { throw 'Dedicated gateway configuration differs from approved plan.' }
  $key = Assert-BuddyChildPath (Join-Path $BuddyRoot $config.apiKeyFile)
  if (-not (Test-Path -LiteralPath $key -PathType Leaf) -or (Get-Item -LiteralPath $key).Length -lt 32) { throw 'Root-created API key file missing; never regenerate it in a launcher.' }
}
function New-BuddyRunPaths([string]$Role) {
  if ($Role -notin @('gateway','tunnel')) { throw 'Invalid Buddy role.' }
  $logs = Assert-BuddyChildPath (Join-Path $BuddyRoot 'logs')
  $run = Assert-BuddyChildPath (Join-Path $BuddyRoot 'run')
  New-Item -ItemType Directory -Path $logs,$run -Force | Out-Null
  $tag = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
  return @{ State=(Join-Path $run ($Role+'.json')); Out=(Join-Path $logs ($Role+'-'+$tag+'.stdout.log')); Err=(Join-Path $logs ($Role+'-'+$tag+'.stderr.log')); Tag=$tag }
}
function ConvertTo-BuddyUtcTicks($Value) {
  # ConvertFrom-Json preserves a string in Windows PowerShell5, but may produce
  # DateTime in PowerShell7. Compare the same instant at exact100ns precision.
  if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime.Ticks }
  if ($Value -is [DateTime]) {
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) { throw 'Stored process start time lacks a timezone.' }
    return $Value.ToUniversalTime().Ticks
  }
  if ($Value -is [string] -and $Value -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$') {
    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse($Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)) { return $parsed.UtcDateTime.Ticks }
  }
  throw 'Stored process start time is invalid.'
}
function Get-BuddyOwnedProcess([string]$StatePath,[string]$Marker) {
  if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
  $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  $process = Get-Process -Id $state.ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  $native = Get-CimInstance Win32_Process -Filter ('ProcessId='+$state.ProcessId)
  $storedStartTicks = ConvertTo-BuddyUtcTicks $state.StartTimeUtc
  if (-not $native -or [string]::IsNullOrEmpty($native.CommandLine) -or $native.CommandLine.IndexOf($Marker,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or $process.StartTime.ToUniversalTime().Ticks -ne $storedStartTicks -or $native.ExecutablePath -ne $state.ExecutablePath) { throw 'PID was reused or ownership changed; stop and compare.' }
  return $state
}
function Write-BuddyProcessState($Process,[string]$Role,[string]$Marker,$Paths,[string]$ArtifactHash) {
  $Process.Refresh()
  if ($Process.HasExited) { throw 'Child exited before ownership could be recorded.' }
  $startUtc = $Process.StartTime.ToUniversalTime()
  $executablePath = $Process.Path
  # PS5 can return an empty MainModule path immediately after Start-Process.
  # Resolve it through CIM only while exact start time and command marker agree.
  if ([string]::IsNullOrWhiteSpace($executablePath)) {
    $native = Get-CimInstance Win32_Process -Filter ('ProcessId='+$Process.Id)
    $live = Get-Process -Id $Process.Id -ErrorAction Stop
    if (-not $native -or $Process.HasExited -or $live.StartTime.ToUniversalTime().Ticks -ne $startUtc.Ticks -or [string]::IsNullOrEmpty($native.CommandLine) -or $native.CommandLine.IndexOf($Marker,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Child ownership changed before it could be recorded.' }
    $executablePath = $native.ExecutablePath
  }
  if ([string]::IsNullOrWhiteSpace($executablePath) -or -not [IO.Path]::IsPathRooted($executablePath) -or -not (Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw 'Child executable path is unavailable; no incomplete receipt was written.' }
  $state = [ordered]@{ Role=$Role; ProcessId=$Process.Id; StartTimeUtc=$startUtc.ToString('o'); ExecutablePath=$executablePath; CommandMarker=$Marker; ArtifactSha256=$ArtifactHash; StartedBy='TLPRO Buddy API'; RunTag=$Paths.Tag; Stdout=$Paths.Out; Stderr=$Paths.Err }
  $state | ConvertTo-Json | Set-Content -LiteralPath $Paths.State -Encoding UTF8
  return $state
}
