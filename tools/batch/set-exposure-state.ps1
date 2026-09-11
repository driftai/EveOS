param(
    [Parameter(Mandatory = $true)][string]$Service,
    [ValidateSet('local', 'lan', 'cloudflare')][string]$Mode = 'local',
    [string]$PublicUrl = '',
    [string]$OriginUrl = '',
    [int]$RouterPort = 0,
    [switch]$Inactive
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SafeService = ($Service.ToLowerInvariant() -replace '[^a-z0-9_-]', '')
if (-not $SafeService) { throw 'Service key is required.' }
$Directory = Join-Path $Root 'data\runtime\exposure'
$Path = Join-Path $Directory "$SafeService.json"

if ($Mode -eq 'local' -or $Inactive) {
    Remove-Item -Force $Path -ErrorAction SilentlyContinue
    exit 0
}

New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$Payload = [ordered]@{
    active = $true
    mode = $Mode
    publicUrl = $PublicUrl
    originUrl = $OriginUrl
    routerPort = $RouterPort
    updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
}
$Temp = "$Path.tmp"
$Payload | ConvertTo-Json | Set-Content -LiteralPath $Temp -Encoding UTF8
Move-Item -Force -LiteralPath $Temp -Destination $Path
