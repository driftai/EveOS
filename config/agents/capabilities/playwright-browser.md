# Playwright Browser Operations
Playwright is robot-user infrastructure, not an authority source.

- User approval must be recorded before execution starts.
- Never use Playwright to approve the same job that it will execute.
- Bind actions to the exact room, job, digest, nonce, expiry, and target.
- Use registered scenarios or bounded actions; do not invent unrestricted JavaScript or URLs.
