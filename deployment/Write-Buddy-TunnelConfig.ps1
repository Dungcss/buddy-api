param(
  [Parameter(Mandatory=$true)][guid]$TunnelId,
  [Parameter(Mandatory=$true)][string]$CredentialFile,
  [Parameter(Mandatory=$true)][switch]$GatewayLocallyVerified,
  [Parameter(Mandatory=$true)][string]$Hostname
)
. (Join-Path $PSScriptRoot 'Buddy-Deploy.Common.ps1')
Assert-BuddyGuards
Assert-BuddyRoot
if (-not $GatewayLocallyVerified) { throw 'Root must verify the local gateway before tunnel preparation.' }
$expectedCredential = Assert-BuddyChildPath (Join-Path $BuddyRoot 'secrets\tunnel-credentials.json')
if ([IO.Path]::GetFullPath($CredentialFile) -ne $expectedCredential -or -not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) { throw 'Only the new tunnel dedicated credential file is permitted.' }
$configPath = Join-Path $BuddyRoot 'cloudflared.yml'
if (Test-Path -LiteralPath $configPath) { throw 'Dedicated tunnel config already exists; do not overwrite it.' }
$id = $TunnelId.ToString()
# The dashboard path rule comes first so one hostname can serve both surfaces.
$config = "tunnel: $id`ncredentials-file: '$CredentialFile'`nmetrics: 127.0.0.1:0`ningress:`n  - path: ^/dashboard`n    service: http://127.0.0.1:3191`n  - hostname: $Hostname`n    service: http://127.0.0.1:3190`n  - service: http_status:404`n"
[IO.File]::WriteAllText($configPath,$config,[System.Text.UTF8Encoding]::new($false))
[pscustomobject]@{ConfigPath=$configPath;ConfigSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash.ToLowerInvariant();TunnelId=$id}
