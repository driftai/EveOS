# ChatGPT App Terminal Relay

Terminal Relay is a first-class EveOS/Nexus Browser Base Mode capability.
It validates the current checkout and can return a privacy-sanitized report to the exact ChatGPT Windows App conversation selected in Base Mode.

## Setup

1. Start Nexus Browser.
2. Choose **App-Origin Targets** in Base Mode.
3. Open the intended ChatGPT Windows App conversation, refresh apps, and connect it.
4. Expand **Terminal Relay**.
5. Copy one run command and paste it once from `tools/Nexus-Browser`.

## Commands

- `npm run smoke:terminal-driver` — standard run.
- `npm run smoke:terminal-driver -- --no-pull` — never pull before validating.
- `npm run smoke:terminal-driver -- --full` — include the complete Nexus Browser suite.
- `npm run smoke:terminal-driver -- --local-only` — validate and save reports without provider transmission.
- `npm run smoke:terminal-driver -- --push` — allow a normal push only when validation is green and the working tree is clean.

## Repository safety

The current branch is discovered dynamically. Terminal Relay never creates or switches branches, auto-stashes, resets, discards work, creates commits, or force-pushes.
Automated Git calls use `--no-pager` plus pager-disabled environment variables, so they cannot stop at an `(END)` screen.
Independent failures are recorded and later independent checks continue.

## Privacy boundary

The full diagnostic report never becomes the provider message.
A separate provider payload masks EveOS/user-home paths, authorization headers, common tokens/API keys, passwords/secrets, cookies, and URL user-info credentials.
The exact provider-eligible payload is saved before transmission and its SHA-256 is stored in metadata.
The driver does not dump arbitrary shell history or environment variables.

## EveOS-local runtime

Runtime data stays under `data/runtime/nexus-browser/terminal-relay/`.
Each run stores `full-local.log`, `provider-report.txt`, and `metadata.json` under `runs/<run-id>/`.
`latest.json` is metadata-only for Base Mode; raw reports are not served by HTTP.
NPM diagnostic logs are redirected to `terminal-relay/npm-logs/`.
The newest 20 runs are retained. `data/runtime/` is already ignored by Git.

## Target scoping

Base Mode stores the selected App-Origin binding locally.
Terminal Relay refuses to send if the selected ChatGPT target is missing, changed, or no longer matches the bound conversation.
It never broadcasts a terminal report to every detected app target.

## Delivery states

- `PASS`: delivery was accepted and the reply was captured.
- `DELIVERED_CAPTURE_FAILED`: delivery was accepted but reply capture failed afterward.
- `FAIL`: delivery was not confirmed.
- `LOCAL_ONLY`: provider transmission was disabled.

## External dependencies

Terminal Relay code, UI, tests, docs, reports, metadata, and logs live in EveOS/Nexus Browser.
The ChatGPT Windows App and Microsoft WinApp CLI remain system-installed dependencies.