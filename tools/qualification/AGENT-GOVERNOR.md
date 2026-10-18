# EveOS Agent Governor — quota-conscious engineering lane (phase 1)

## What is real and what is estimated

Codex `account/rateLimits/read` supplies the remaining five-hour/weekly **account** allowances and reset times. It does **not** provide a fixed quota debit per model/reasoning level on a $20 Plus plan. API token rates are separate from Plus usage, and neither should be converted into fabricated Plus-token allowances.

The governor records before/after **account percentage-point changes** alongside the actual selected model, reasoning effort, and elapsed time. The Nexus panel shows observed medians only and warns that other sessions can contribute. Resetting/replenished/incomplete readings are rejected from burn calibration. At least three comparable model/effort samples are needed before observed medians affect reserved quota. Samples are indicative, not causal, especially when other Work/Codex tasks share the allowance.

| Task tier | Default Codex model | Reasoning | Baseline remaining quota reserve |
|---|---|---|---|
| small (bounded edits/triage) | `gpt-5.6-luna` | low | 6% each window |
| medium (multi-file changes) | `gpt-5.6-terra` | medium | 10% each window |
| complex (architecture/recovery) | `gpt-5.6-sol` | medium | 15% each window |

`high` requires `--effort high --permit-high`. No automatic `ultra`, `xhigh`, `max` or top-tier escalation. CLI model availability is checked at runtime; an unavailable model **blocks** instead of silently promoting. The selection is a practical heuristic, not a guarantee of equivalent answer quality. Also note that default model aliases and availability may change.

For *API pricing only*, published October 2026 list prices per million input/output tokens are approximately Luna $0.20/$1.20, Terra $2/$12, Sol $4/$20. Those are **not** the Plus allowance cost per job. Check current official pricing before using dollar estimates. No API keys are read or required.

## Governed execution states

`PREFLIGHT → QUOTA_BLOCKED` or `RUNNING → EXECUTED_NOT_QUALIFIED → QUALIFYING → QUALIFIED → [explicit] COMMITTING → LOCAL_COMMIT → PUBLISHED`

Failures enter `UNKNOWN_EXECUTION_OUTCOME_NO_RETRY`, `QUALIFICATION_FAILED`, `SOURCE_DRIFT_AFTER_QUALIFICATION`, or `STOP_REVIEW_REQUIRED`. A crashed run can leave `RUNNING` in durable evidence: **inspect**, never replay the Codex task automatically. The governor has no automatic agent retry; `qualify` explicitly re-runs gates after a completed task and human review.

All receipts and logs are written under ignored `data/runtime/smoke-results/agent-governor/<run>/`. Model output stays in local log files and is not sent to the quota endpoint. Nexus receives only summarized model/effort group statistics.

## Workflow

1. Check out `eve/nexus-machine-spaces`, enable canonical hooks with `npm run hooks:install`, ensure worktree clean and remote tracking aligned. Do not run this tool in another worktree with unrelated edits.
2. Write mission text within `data/runtime/...` and list every exact file the mission is authorized to modify/create. No wildcard file grants. Use plan mode first; it doesn't contact a model:

```powershell
python -B tools/qualification/agent_governor.py plan --repo . --run-dir data/runtime/smoke-results/agent-governor/sample --tier medium
```

3. To run a model, create a **new** run folder and supply explicit branch-head and allowed file arguments:

```powershell
python -B tools/qualification/agent_governor.py run --repo . --run-dir data/runtime/smoke-results/agent-governor/my-run-001 --expected-head (git rev-parse HEAD) --tier medium --mission data/runtime/smoke-results/my-mission.txt --allow-file tools/Nexus-Browser/tests/example.test.js
```

4. The task uses a model only if the Codex app-server reports **fresh, complete** windows above the reserve. The agent must use `workspace-write`; approval policy is `never`. After task completion it runs the governor tests, full Nexus tests, AI-control, security and `npm run verify`. Source changes must match *exactly* the listed authorized paths.
5. Inspect files, reports and evidence. To publish after a qualified run, **explicitly** request guarded publication:

```powershell
python -B tools/qualification/agent_governor.py publish --repo . --run-dir data/runtime/smoke-results/agent-governor/my-run-001 --authorize-publish
```

This stages the exact approved file set, commits with local hooks, verifies a clean checkout, refreshes the tracking ref only after checking remote baseline, pushes the named branch reference through the standard pre-push hook, and requires GitHub SHA readback. Never force pushes and never touches main.

A single `run ... --authorize-publish` can also perform the guarded final publication after qualification. Only do this when the mission's allowed file list and publication have already been explicitly approved.

For an explicitly reviewed test failure where the Codex task itself already completed, `qualify` reruns tests **without dispatching the model**:

```powershell
python -B tools/qualification/agent_governor.py qualify --repo . --run-dir data/runtime/smoke-results/agent-governor/my-run-001
```

There is no automatic retry of uncertain agent execution or provider commands. Failed publication leaves the local commit in place and requires separate manual reconciliation.

## Windows observability

Run `status` to read a durable receipt. In a second terminal window use:

```powershell
Get-Content -Wait -Tail 30 'data/runtime/smoke-results/agent-governor/my-run-001/events.jsonl'
```

`codex-run.log`, `codex-final.txt`, gate-specific logs, before/after quota, `receipt.json`, and `events.jsonl` stay available after completion. Opening the observer never re-runs the agent.

## Limits / future qualification

- This first lane is **not installed or native-qualified** until applied to the Windows checkout and full gates pass. It cannot interrupt independent Codex/Work sessions to avoid simultaneous usage.
- Its exclusive per-run lock prevents duplicate invocation for the *same* run folder; it does not block unrelated Codex sessions.
- The exact permitted file set is declared **before** dispatch. Unexpected edits are preserved for review, never silently staged or pushed.
- A successful process exit is not evidence that real browser/provider acceptance passed; those lanes remain opt-in.
- Initial default models are a conservative policy. Actual supported model IDs and availability must be verified on the workstation.
- Consider a separate visible worker process supervisor / multi-provider scheduler only after this lane's production qualification and crash recovery tests.
