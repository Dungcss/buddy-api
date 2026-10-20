param([Parameter(Mandatory=$true)][switch]$RootPublicationApproved)
. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
Assert-BuddyGuards
Assert-BuddyRoot
if (-not $RootPublicationApproved) { throw 'Root must authorize actual publication first.' }
if (Get-ScheduledTask -TaskName $BuddyTaskName -ErrorAction SilentlyContinue) { throw 'Task name already exists; no existing task will be changed.' }
$launcher = Join-Path $BuddyRoot 'deployment\Supervise-Buddy.ps1'
$manifest = Join-Path $BuddyRoot 'deployment\launch-manifest.json'
if (-not (Test-Path -LiteralPath $launcher) -or -not (Test-Path -LiteralPath $manifest)) { throw 'Root must install and verify dedicated launch files first.' }
$launch = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($launch.serviceRoot -ne $BuddyRoot -or [string]::IsNullOrWhiteSpace($launch.hostname) -or $launch.port -ne 3190 -or $launch.localVerified -ne $true) { throw 'Root-approved launch manifest is incomplete.' }
Assert-BuddyHash $launcher $launch.supervisorSha256
Assert-BuddyHash (Join-Path $BuddyRoot 'server.mjs') $launch.serverSha256
Assert-BuddyHash (Join-Path $BuddyRoot 'adapter.mjs') $launch.adapterSha256
Assert-BuddyHash (Join-Path $BuddyRoot 'usage.mjs') $launch.usageSha256
Assert-BuddyHash (Join-Path $BuddyRoot 'config.json') $launch.configSha256
Assert-BuddyHash (Join-Path $BuddyRoot 'cloudflared.yml') $launch.tunnelConfigSha256
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launcher+'" -LaunchManifestPath "'+$manifest+'"') -WorkingDirectory $BuddyRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
Register-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\' -Action $action -Trigger @($trigger,$watchdogTrigger) -Principal $principal -Settings $settings -Description 'Dedicated Buddy API gateway and dedicated buddy tunnel; does not alter ai or omni.' | Out-Null
$run = Assert-BuddyChildPath (Join-Path $BuddyRoot 'run'); New-Item -ItemType Directory -Path $run -Force | Out-Null
$xml = Export-ScheduledTask -TaskName $BuddyTaskName -TaskPath '\'
$hash = [Security.Cryptography.SHA256]::Create(); try { $xmlHash = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
@{TaskName=$BuddyTaskName;CreatedBy='TLPRO Buddy API';CreatedAt=[DateTime]::UtcNow.ToString('o');XmlSha256=$xmlHash;Launcher=$launcher} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'logon-task.json') -Encoding UTF8
[pscustomobject]@{TaskName=$BuddyTaskName;XmlSha256=$xmlHash;Created=$true}
