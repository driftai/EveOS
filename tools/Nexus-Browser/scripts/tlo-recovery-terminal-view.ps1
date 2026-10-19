param(
    [Parameter(Mandatory=$true)][string]$LogPath,
    [Parameter(Mandatory=$true)][string]$DonePath,
    [Parameter(Mandatory=$true)][string]$Title
)
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = $Title
Write-Host 'EveOS supervised recovery — read-only live terminal view' -ForegroundColor Cyan
Write-Host 'The managed Machine Spaces process owns execution and interruption.' -ForegroundColor DarkGray
Write-Host ''
$position = 0L
$deadline = (Get-Date).AddMinutes(45)
while ($true) {
    if ((Get-Date) -ge $deadline) {
        Write-Host 'Observer expired without a final marker. Check the authoritative Machine Spaces job; this view cannot infer its outcome.' -ForegroundColor Yellow
        break
    }
    if (Test-Path -LiteralPath $LogPath) {
        $stream = [System.IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
        try {
            if ($position -gt $stream.Length) { $position = 0L }
            [void]$stream.Seek($position, 'Begin')
            $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)
            try {
                $text = $reader.ReadToEnd()
                if ($text) { Write-Host $text -NoNewline }
                $position = $stream.Position
            } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
    }
    if ((Test-Path -LiteralPath $DonePath) -and (Test-Path -LiteralPath $LogPath) -and ((Get-Item -LiteralPath $LogPath).Length -le $position)) { break }
    Start-Sleep -Milliseconds 250
}
Write-Host ''
Read-Host 'Recovery settled. Press Enter to close this view'
