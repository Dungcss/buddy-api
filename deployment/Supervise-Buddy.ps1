param([string]$LaunchManifestPath=(Join-Path $PSScriptRoot 'launch-manifest.json'))
. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
$supervisorPath = Join-Path $PSScriptRoot 'Supervise-Buddy.ps1'
$logPath = Join-Path $BuddyRoot 'logs\supervisor.jsonl'
function Write-BuddySupervisorEvent([string]$Event, $Details) {
  $row = @{at=[DateTime]::UtcNow.ToString('o');event=$Event;details=$Details}
  [IO.File]::AppendAllText($logPath,($row | ConvertTo-Json -Compress -Depth 4)+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))
}
$mutex = [Threading.Mutex]::new($false,'Local\TLPROBuddyAPISupervisor')
$owned = $false
$subscriptions = @()
try {
  $owned = $mutex.WaitOne(0)
  if (-not $owned) { return }
  Assert-BuddyGuards
  Assert-BuddyRoot
  $manifest = Get-Content -LiteralPath $LaunchManifestPath -Raw | ConvertFrom-Json
  Assert-BuddyHash $supervisorPath $manifest.supervisorSha256
  $self = Get-Process -Id $PID
  $paths = @{State=(Join-Path $BuddyRoot 'run\supervisor.json');Out=$logPath;Err=$logPath;Tag=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')}
  Write-BuddyProcessState $self 'supervisor' $supervisorPath $paths $manifest.supervisorSha256 | Out-Null
  Write-BuddySupervisorEvent 'supervisor_started' @{processId=$PID}
  $lastRecovery = [DateTime]::MinValue
  $streak = 0
  while ($true) {
    # The guarded existing launcher reuses the healthy role and starts only a
    # missing journaled process. It refuses untracked listeners or hash drift.
    & (Join-Path $PSScriptRoot 'Start-Buddy-Service.ps1') -LaunchManifestPath $LaunchManifestPath | Out-Null
    $watched = @()
    $subscriptions = @()
    try {
      foreach ($role in @('gateway','tunnel')) {
        $marker = if ($role -eq 'gateway') { Join-Path $BuddyRoot 'server.mjs' } else { Join-Path $BuddyRoot 'cloudflared.yml' }
        $state = Get-BuddyOwnedProcess (Join-Path $BuddyRoot ('run\'+$role+'.json')) $marker
        if (-not $state) { throw 'A Buddy child exited before supervision began.' }
        $process = Get-Process -Id $state.ProcessId -ErrorAction Stop
        $identifier = 'BuddySupervisor.'+$PID+'.'+$role+'.'+$state.ProcessId
        $process.EnableRaisingEvents = $true
        Register-ObjectEvent -InputObject $process -EventName Exited -SourceIdentifier $identifier | Out-Null
        $subscriptions += $identifier
        $watched += @{Role=$role;Process=$process;Identifier=$identifier}
      }
      Write-BuddySupervisorEvent 'children_watched' @($watched | ForEach-Object { @{role=$_.Role;processId=$_.Process.Id} })
      if (-not @($watched | Where-Object { $_.Process.HasExited }).Count) {
        # Blocks on process-exit events, with no recurring network/DOM polling.
        Wait-Event | Out-Null
      }
      $failed = @($watched | Where-Object { $_.Process.HasExited } | ForEach-Object { $_.Role })
    } finally {
      foreach ($identifier in $subscriptions) {
        Unregister-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue
        Get-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
      }
      $subscriptions = @()
      foreach ($item in $watched) { $item.Process.Dispose() }
    }
    if (-not $failed.Count) { continue }
    $now = [DateTime]::UtcNow
    if (($now-$lastRecovery).TotalSeconds -gt 60) { $streak=0 }
    $delay = if ($streak -eq 0) { 0 } else { [Math]::Min(30,[Math]::Pow(2,[Math]::Min($streak-1,5))) }
    $streak++
    $lastRecovery=$now
    Write-BuddySupervisorEvent 'child_exit_recovery' @{roles=$failed;backoffSeconds=$delay}
    if ($delay -gt 0) { Start-Sleep -Seconds $delay }
  }
} catch {
  # No raw exception text, credentials, request headers or model prompts.
  Write-BuddySupervisorEvent 'supervisor_failed' @{action='Review source/ownership guards and child startup logs.'}
  exit 1
} finally {
  foreach ($identifier in $subscriptions) {
    Unregister-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
  }
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
