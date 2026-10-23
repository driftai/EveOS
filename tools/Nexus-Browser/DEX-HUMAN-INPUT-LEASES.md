# Dex Human Input authorization leases

Human Input is a server authorization state, not a browser preference. The banner is
locked until localhost issues a bounded lease after an explicit Enable Human Input
gesture. A primary-controller role alone grants no edit, delete, or relay-control
authority.

## Lease boundary

Each Human Input lease is held only in server memory and is bound to:

- the exact live WebSocket object;
- a server-created controller actor ID;
- one exact Dex room, or a one-use room-creation scope;
- an explicit operation set;
- an expiration timestamp;
- the current primary-controller generation; and
- the current Nexus server epoch.

The browser receives an opaque token plus descriptive actor/epoch/generation fields.
Those fields help return stable stale-session errors; they never establish authority.
The server always resolves the token back to its own record and checks the actual socket,
actor, scope, operation, expiry, generation, and epoch.

Room creation uses a separate 15-second, one-use creation lease. After creation, all old
Human Input leases on that socket are revoked and a new lease is issued only for the new
room. Ordinary room leases do not authorize creation or cross-room edits.

## Revocation

Human Input relocks on explicit disable, socket loss/reconnect, primary-controller
transfer, room selection/scope change, lease expiration, room deletion, and server epoch
change. Replayed, revoked, cross-socket, cross-room, expired, stale-generation, and
stale-epoch authorizations have distinct stable failure codes.

The UI renders Active, Denied, and Expired states from server responses and lease time.
`data-human-input="enabled"` is set only while the exact-room server lease is usable, so
the existing Machine Spaces UI gate does not mistake a pending or stale Dex toggle for
active Human Input.

## Independent paths

- A locked controller may still send a bounded user message. The server appends only that
  exact user message, durably saves it, and then invokes the existing scheduler. It cannot
  use this path to edit room structure or runtime state.
- Valid provider-control work receives a short-lived server-correlated grant for its
  already-authorized action. It does not borrow or imply a Human Input lease.
- Terminal operator/TUI messages retain their direct-loopback allowlist and never receive
  browser Human Input authority.
- Machine Spaces command approvals, grants, challenges, and execution controls remain
  owned by the Machine Spaces authorization modules. A Dex lease is not an execution
  approval.

## Trust limitation

This is an authorization and replay-fencing boundary inside the existing local Nexus
trust zone. A loopback WebSocket connection, browser Origin, `hello.role`, or
`clientKind` is not cryptographic proof that a real human is present. The explicit UI
gesture is meaningful for normal local operation, but malicious code already able to
connect inside the accepted loopback/Origin boundary is outside this phase's identity
assurance. Do not describe these leases as user authentication or cryptographic human
attestation.
