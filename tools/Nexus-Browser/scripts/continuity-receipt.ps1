# Dot-source from an explicitly scoped one-pass installer; no background tasks.
# Producers must invoke Start-ContinuityAttempt before their first mutation and
# use the returned head.eventId/head.sha256 as the actual receipt predecessor.
function Start-ContinuityAttempt {
    param([string]$StateTool,[string]$Repo,[string]$Scope,[string]$CandidateZip,
          [string]$CandidateSHA,[string]$ExpectedHeadId,[string]$ExpectedHeadSHA,[switch]$Resume)
    $argsList = @('begin',$Repo,$Scope,$CandidateZip,$CandidateSHA,$ExpectedHeadId,$ExpectedHeadSHA)
    if ($Resume) { $argsList += '--resume' }
    $raw = & node $StateTool @argsList
    if ($LASTEXITCODE -ne 0) { throw 'CONTINUITY_INCOMPLETE: cannot persist intent; do not mutate' }
    $attempt = $raw | ConvertFrom-Json
    if ($attempt.status -ne 'PASS' -or !$attempt.pending -or !$attempt.head.eventId) { throw 'Invalid attempt receipt' }
    return $attempt.head
}
function Seal-ContinuityReceipt {
    param([Parameter(Mandatory=$true)][string]$ReceiptRoot,
          [Parameter(Mandatory=$true)][string]$EventJson,
          [Parameter(Mandatory=$true)][string]$Checker,
          [string]$StateTool,[string]$Repo,[string]$Scope)
    $ErrorActionPreference = 'Stop'
    $useState = $StateTool -or $Repo -or $Scope
    if ($useState -and !($StateTool -and $Repo -and $Scope)) { throw 'Incomplete state parameters' }
    # EventJson must be freshly written AFTER actual outcome and rollback evidence.
    & node $Checker render $ReceiptRoot $EventJson
    if ($LASTEXITCODE -ne 0) { throw 'Continuity rendering failed; raw evidence retained' }
    $zip = "$ReceiptRoot.zip"
    if (Test-Path -LiteralPath $zip) { throw 'Receipt ZIP already exists' }
    Compress-Archive -Path (Join-Path $ReceiptRoot '*') -DestinationPath $zip -ErrorAction Stop
    & node $Checker verify-zip $zip
    if ($LASTEXITCODE -ne 0) { throw 'Continuity ZIP invalid; raw evidence retained' }
    $digest = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "UPLOAD_RETURN_ZIP=$zip"
    Write-Host ('SHA256 '+$digest)
    if ($useState) {
        $raw = & node $StateTool record $Repo $Scope $zip $digest
        if ($LASTEXITCODE -ne 0) { throw 'CONTINUITY_INCOMPLETE: sealed receipt retained; reconcile local attempt; do not replay' }
        $state = $raw | ConvertFrom-Json
        if ($state.status -ne 'PASS' -or $state.pending) { throw 'CONTINUITY_INCOMPLETE: receipt retained, local state not closed' }
        if ($state.blocked) { Write-Host 'CONTINUITY_LOCAL_RECORDED_RECONCILIATION_REQUIRED' }
        else { Write-Host 'CONTINUITY_LOCAL_RECORDED' }
    }
}

# Future publishers use this read-only gate after authorized WIP preservation and
# exact staged-tree audit. ObservedRemote must come from a fresh ls-remote query.
# The returned arguments keep the actual pre-push hook enabled. Do not treat this
# as authorization or a replacement for the hook; recheck before one dispatch.
function Get-ContinuityPublicationPlan {
    param([string]$PublicationTool,[string]$Repo,[string]$Base,[string]$Commit,
          [string]$Tree,[string]$ObservedRemote,[string]$HookSHA256)
    $raw = & node $PublicationTool $Repo $Base $Commit $Tree $ObservedRemote $HookSHA256
    if ($LASTEXITCODE -ne 0) { throw 'PUBLICATION_PREFLIGHT_BLOCKED: reconcile exact guardrail before push' }
    $plan = $raw | ConvertFrom-Json
    if ($plan.status -ne 'PASS' -or $plan.commit -ne $Commit -or $plan.tree -ne $Tree -or !$plan.pushArguments) { throw 'Invalid publication plan' }
    return $plan
}
