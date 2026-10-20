param(
  [Parameter(Mandatory=$true)][guid]$TunnelId,
  [Parameter(Mandatory=$true)][string]$ConfigSha256,
  [Parameter(Mandatory=$true)][switch]$GatewayLocallyVerified,
  # The hostname the manifest declares; the ingress rule must match it exactly.
  [Parameter(Mandatory=$true)][string]$ExpectedHostname
)
. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
Assert-BuddyGuards
Assert-BuddyRoot
if (-not $GatewayLocallyVerified) { throw 'Local verification is required.' }
$configPath = Join-Path $BuddyRoot 'cloudflared.yml'
Assert-BuddyHash $configPath $ConfigSha256
$config = Get-Content -LiteralPath $configPath -Raw
if ($config -notmatch ('(?m)^tunnel: '+[regex]::Escape($TunnelId.ToString())+'\s*$') -or ([regex]::Matches($config,'(?m)^\s*- hostname:').Count -ne 1) -or $config -notmatch ('(?m)^\s*- hostname: '+[regex]::Escape($ExpectedHostname)+'\s*$') -or $config -notmatch '(?m)^\s*service: http://127\.0\.0\.1:3190\s*$') { throw 'Dedicated ingress differs from approved plan.' }
$health = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3190/healthz' -TimeoutSec 5
if ($health.StatusCode -ne 200) { throw 'Gateway health check failed.' }
$existing = Get-BuddyOwnedProcess (Join-Path $BuddyRoot 'run\tunnel.json') $configPath
if ($existing) { [pscustomobject]@{Role='tunnel';ProcessId=$existing.ProcessId;AlreadyRunning=$true}; return }
$paths = New-BuddyRunPaths 'tunnel'
$quotedConfigPath = '"' + $configPath + '"'
$tunnelArguments = @('tunnel','--no-autoupdate','--loglevel','warn','--config',$quotedConfigPath,'run',$TunnelId.ToString())
$process = Start-Process -FilePath $BuddyCloudflared -ArgumentList $tunnelArguments -WorkingDirectory $BuddyRoot -WindowStyle Hidden -RedirectStandardOutput $paths.Out -RedirectStandardError $paths.Err -PassThru
$state = Write-BuddyProcessState $process 'tunnel' $configPath $paths $ConfigSha256
[pscustomobject]@{Role='tunnel';ProcessId=$state.ProcessId;StartTimeUtc=$state.StartTimeUtc;StateFile=$paths.State;TunnelId=$TunnelId.ToString()}
