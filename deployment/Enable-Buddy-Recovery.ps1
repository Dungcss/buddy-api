. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
Assert-BuddyGuards
Assert-BuddyRoot
$receiptPath = Join-Path $BuddyRoot 'run\logon-task.json'
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if ($receipt.TaskName -ne $BuddyTaskName -or $receipt.CreatedBy -ne 'TLPRO Buddy API') { throw 'Not an owned Buddy task.' }
function Get-TaskXmlHash {
  $xml=Export-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\'
  $hash=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
if ((Get-TaskXmlHash) -ne $receipt.XmlSha256) { throw 'Task changed; stop and compare.' }
$task=Get-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\'
if ($task.State -eq 'Running') { throw 'Task is already running; do not interrupt it implicitly.' }
$launcher=Join-Path $BuddyRoot 'deployment\Supervise-Buddy.ps1'
$manifestPath=Join-Path $BuddyRoot 'deployment\launch-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Assert-BuddyHash $launcher $manifest.supervisorSha256
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launcher+'" -LaunchManifestPath "'+$manifestPath+'"') -WorkingDirectory $BuddyRoot
$settings=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
# Same task, IgnoreNew: a running supervisor is never replaced.
# A repeating trigger also recovers an externally terminated supervisor.
$triggers = @($task.Triggers)
if (-not @($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' -and $_.Repetition.Interval -eq 'PT1M' -and [string]::IsNullOrEmpty($_.Repetition.Duration) }).Count) {
  $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
}
Set-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\' -Action $action -Trigger $triggers -Settings $settings | Out-Null
$receipt.Launcher=$launcher
$receipt.XmlSha256=Get-TaskXmlHash
$receipt | Add-Member -NotePropertyName RecoveryEnabledAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
[pscustomobject]@{TaskName=$BuddyTaskName;XmlSha256=$receipt.XmlSha256;Recovery='Process-exit supervisor; scheduler rechecks every minute with IgnoreNew; failure retry 3 times.'}
