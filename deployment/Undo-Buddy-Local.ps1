param([Parameter(Mandatory=$true)][switch]$RootUndoApproved)
. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
Assert-BuddyGuards
if (-not $RootUndoApproved) { throw 'Root must authorize undo of the journaled Buddy resources.' }
$taskReceiptPath = Join-Path $BuddyRoot 'run\logon-task.json'
if (Test-Path -LiteralPath $taskReceiptPath) {
  $receipt = Get-Content -LiteralPath $taskReceiptPath -Raw | ConvertFrom-Json
  if ($receipt.TaskName -ne $BuddyTaskName -or $receipt.CreatedBy -ne 'TLPRO Buddy API' -or $receipt.Launcher -notin @((Join-Path $BuddyRoot 'deployment\Start-Buddy-Service.ps1'),(Join-Path $BuddyRoot 'deployment\Supervise-Buddy.ps1'))) { throw 'Task ownership receipt differs; stop and compare.' }
  $task = Get-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($task) {
    $xml = Export-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\'
    $hash = [Security.Cryptography.SHA256]::Create(); try { $xmlHash = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($xmlHash -ne $receipt.XmlSha256) { throw 'Task changed after installation; stop and compare.' }
    Unregister-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\' -Confirm:$false
  }
}
# Stop exactly the journaled dedicated tunnel, then gateway; never enumerate-and-kill.
foreach ($role in @('supervisor','tunnel','gateway')) {
  $marker = switch ($role) { 'supervisor' { Join-Path $BuddyRoot 'deployment\Supervise-Buddy.ps1' } 'tunnel' { Join-Path $BuddyRoot 'cloudflared.yml' } 'gateway' { Join-Path $BuddyRoot 'server.mjs' } }
  $state = Get-BuddyOwnedProcess (Join-Path $BuddyRoot ('run\'+$role+'.json')) $marker
  if ($state) {
    if ($state.Role -ne $role -or $state.StartedBy -ne 'TLPRO Buddy API') { throw 'Process journal ownership differs.' }
    Assert-BuddyHash $marker $state.ArtifactSha256
    Stop-Process -Id $state.ProcessId -ErrorAction Stop
    [pscustomobject]@{Role=$role;StoppedProcessId=$state.ProcessId}
  }
}
# Do not remove DNS/tunnel/account credentials here. Follow the exact journaled resource plan.
