param(
    [switch]$IncludeFailureTails,
    [string]$OutFile = ""
)
$ErrorActionPreference = "Stop"

# Read-only Git/qualification inspection. Only writes a user-visible handoff
# under %TEMP% and optionally copies it to the local clipboard.
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$doc = Join-Path $repo "docs\EVEOS-DEX-TUI-CHAT-HANDOFF.md"
$evidence = Join-Path $repo "data\runtime\smoke-results\timed-qualification"
if (-not (Test-Path -LiteralPath $doc)) {
    throw "Handoff document is missing: $doc"
}
if (-not (Test-Path -LiteralPath $evidence)) {
    throw "Qualification reports directory is missing: $evidence"
}

$branch = (& git -C $repo branch --show-current | Out-String).Trim()
$head = (& git -C $repo rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Cannot read Git HEAD." }
$worktree = @(& git -C $repo status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Git worktree." }

$reports = @(Get-ChildItem -LiteralPath $evidence -Directory -Filter "verify-*" |
    ForEach-Object {
        $candidate = Join-Path $_.FullName "report.json"
        if (Test-Path -LiteralPath $candidate) { Get-Item -LiteralPath $candidate }
    } | Sort-Object -Property LastWriteTimeUtc -Descending)
if (-not $reports.Count) { throw "No full qualification report found." }

$reportPath = $reports[0].FullName
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add((Get-Content -LiteralPath $doc -Raw).Trim())
$lines.Add("")
$lines.Add("---")
$lines.Add("## Newest local qualification results")
$lines.Add("Captured: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$lines.Add("Branch: $branch")
$lines.Add("HEAD: $head")
$lines.Add("Working tree clean: $($worktree.Count -eq 0)")
$lines.Add("Report: $reportPath")
$lines.Add("Status: $($report.status)")
$lines.Add("Release eligible: $($report.releaseEligible)")
$lines.Add("Observed gates: $($report.observedGates) / $($report.expectedGates)")
$lines.Add("Elapsed seconds: $($report.elapsedSeconds)")

$failed = @($report.gates | Where-Object { $_.status -eq "FAIL" })
$passed = @($report.gates | Where-Object { $_.status -eq "PASS" })
$lines.Add("Passed gates: $($passed.Count)")
$lines.Add("Failed gates: $($failed.Count)")
foreach ($gate in $failed) {
    $lines.Add("- FAIL $($gate.gate) (exit $($gate.exitCode)); log: $($gate.log)")
    if ($IncludeFailureTails -and $gate.log) {
        $logPath = Join-Path $repo ([string]$gate.log)
        if (Test-Path -LiteralPath $logPath) {
            $lines.Add("### Tail of $($gate.gate) (review before sharing)")
            $lines.Add('~~~text')
            foreach ($item in (Get-Content -LiteralPath $logPath -Tail 35)) {
                $lines.Add([string]$item)
            }
            $lines.Add('~~~')
        }
    }
}
$lines.Add("")
$lines.Add("Important: this is a read-only result summary, NOT proof of a release pass unless status PASS and releaseEligible True. Review any included logs for secrets before sharing.")

if (-not $OutFile) {
    $OutFile = Join-Path $env:TEMP "eveos-nexus-tui-next-chat-handoff.md"
}
$parent = Split-Path -Parent $OutFile
if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$lines.ToArray() | Set-Content -LiteralPath $OutFile -Encoding UTF8

$copied = $false
if (Get-Command Set-Clipboard -ErrorAction SilentlyContinue) {
    try {
        Set-Clipboard -Value ($lines -join [Environment]::NewLine)
        $copied = $true
    } catch {
        Write-Warning "Clipboard unavailable: $($_.Exception.Message)"
    }
}
Write-Host "HANDOFF_FILE: $OutFile"
Write-Host "COPIED_TO_CLIPBOARD: $copied"
Write-Host "REPORT_STATUS: $($report.status)"
Write-Host "RELEASE_ELIGIBLE: $($report.releaseEligible)"
Write-Host "Paste into the new chat (or attach the file), after reviewing any failure tails."
