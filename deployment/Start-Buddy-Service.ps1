param([string]$LaunchManifestPath=(Join-Path $PSScriptRoot 'launch-manifest.json'))
. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
Assert-BuddyGuards
Assert-BuddyRoot
$manifest = Get-Content -LiteralPath $LaunchManifestPath -Raw | ConvertFrom-Json
if ($manifest.serviceRoot -ne $BuddyRoot -or [string]::IsNullOrWhiteSpace($manifest.hostname) -or $manifest.port -ne 3190 -or $manifest.localVerified -ne $true) { throw 'Root-approved launch manifest missing.' }
$mutex = [System.Threading.Mutex]::new($false,'Local\TLPROBuddyAPIStartup')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); throw 'Another Buddy launch is in progress.' }
try {
  & (Join-Path $PSScriptRoot 'Start-Buddy-Gateway.ps1') -ServerSha256 $manifest.serverSha256 -AdapterSha256 $manifest.adapterSha256 -ConfigSha256 $manifest.configSha256 -ProtocolHashes $manifest.protocolHashes -UsageSha256 $manifest.usageSha256 -ApiKeysSha256 $manifest.apiKeysSha256
  # Bounded readiness checks only at service startup; never poll the application thereafter.
  $ready = $false
  foreach ($attempt in 1..10) { try { if ((Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3190/healthz' -TimeoutSec 2).StatusCode -eq 200) { $ready=$true; break } } catch {} ; Start-Sleep -Milliseconds 300 }
  if (-not $ready) { throw 'Gateway did not become ready; tunnel was not started.' }
  & (Join-Path $PSScriptRoot 'Start-Buddy-Tunnel.ps1') -TunnelId ([guid]$manifest.tunnelId) -ConfigSha256 $manifest.tunnelConfigSha256 -GatewayLocallyVerified -ExpectedHostname $manifest.hostname
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
