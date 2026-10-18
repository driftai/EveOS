# EveOS Engineering Safeguards

## Purpose

`tools/qualification/eveos_engineering_safeguards.v1.json` is the small, reviewable registry for
engineering invariants that must survive later feature work. Each entry names the problem that
was solved, the validated behavior, its authoritative tests, a known-good recovery commit, and
the steps required for an intentional upgrade.

The first protected invariant is Qualification Engine v3. The deterministic contract rejects
loss of any of its 41 release obligations, manifest/legacy-oracle drift, replacement of
`npm run verify` with a partial profile, removal of `verify:legacy`, removal of scheduler or
safeguard tests from normal guardrails, and stale or incomplete release receipts. Mutation tests
also prove that a coherent intentional expansion is accepted.

## Enforcement

Run the focused contract with:

```powershell
npm run --silent smoke:engineering-safeguards-contract
```

It is part of `npm run test:guardrails`, which is also run by the tracked local pre-push hook.
Successful output is one stable summary line; failures identify the broken invariant. The check
is intentionally cheap and does not run the full release suite.

The registry's performance limit is advisory. It compares recent successful, manifest-complete
v3 receipts and warns only after a large same-profile regression; timing variance can never
erase correctness coverage or make an otherwise invalid receipt eligible.

## Intentional changes

When a release obligation is deliberately added, removed, or replaced, update the legacy oracle,
v3 manifest, registry obligation count and recovery reference, focused regression fixtures, and
documentation together. The manifest validator must still prove dependency closure, exact
coverage parity, and approved deduplication. Then run the focused guardrails and one fresh
`npm run verify` before publication.

For recovery or comparison, inspect the known-good checkpoint without rewriting the worktree:

```powershell
git show dcde98d0640267374d686138856c386916543121:tools/qualification/eveos_qualification_manifest.v3.json
git show dcde98d0640267374d686138856c386916543121:tools/qualification/eveos_timed_qualification.py
```

## Remote protection boundary

GitHub Actions is intentionally disabled in this repository today (`workflows=0`). Local tests
and hooks cannot prevent a privileged user from deleting or bypassing them, so no remote required
status check is claimed.

If remote enforcement is enabled later, an administrator should:

1. Add a reviewed workflow for pull requests and protected-branch pushes that runs
   `npm ci --ignore-scripts` followed by `npm run test:guardrails`.
2. Protect `main` and the active integration branch: require pull requests and review, require the
   guardrail check and up-to-date branches, and disallow force pushes and branch deletion.
3. Optionally apply those rules to administrators, then verify the exact required check name with
   a harmless pull request before relying on it.

Git history, the recovery reference, review, local pre-push enforcement, and future required CI
are complementary layers; none should be presented as an absolute guarantee on its own.
