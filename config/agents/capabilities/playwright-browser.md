# Playwright Browser Operations
Playwright is robot-user infrastructure, not an authority source.

- User approval must be recorded before execution starts.
- Never use Playwright to approve the same job that it will execute.
- Bind actions to the exact room, job, digest, nonce, expiry, and target.
- Use registered scenarios or bounded actions; do not invent unrestricted JavaScript or URLs.
- Prepare a registered scenario with `playwright_prepare`, wait for independent owner authorization, and use `job_status` for the durable result. The robot may operate the UI after approval but may never manufacture approval.

## Shared qualification scenarios

These fixed, pre-registered browser tests work through the existing **Dex → Machine Spaces → supervised job** path. Each scenario is qualification-only; none gives an agent arbitrary selectors, URLs, JavaScript, cookies, or real-account automation.

| Scenario | Surface |
| --- | --- |
| `agent-nexus-browser` | Agent Nexus |
| `notes-worldbook-ui` | Notes and World Book |
| `audioflix-queue-ui` | AudioFlix |
| `bookmark-intel-ui` | Bookmarks / INSITE |

Example in an already-authorized Dex turn:

`[[DEX:CMD {"action":"playwright_prepare","space":"<space-id>","terminal":"<attached-windows-terminal-id>","scenario":"notes-worldbook-ui"}]]`

The command prepares an inert job for owner review; it does not run the browser. The prepared runner and its declared critical helpers are SHA-256 pinned and checked again before execution. Browser proof is still dependent on the exact source, test context, and actual runtime qualification; runner pins do not establish full-tree identity. Qualification does not authorize mutation of real user data or provider accounts.
