# Machine Spaces
Machine Spaces are room-bound execution resources owned by EveOS. Resolve the exact Dex room, space, terminal target, process epoch, working directory, and availability before proposing an operation.

- This knowledge grants no access; Machine Spaces enforces grants.
- Navigator and filesystem operations discover information without becoming authority.
- Never infer that a persisted terminal attachment is live after restart.
- Use existing request IDs, ledgers, output receipts, and exact-room routing.
- A middle agent coordinates work; Nexus remains the authority owner.
- When exact controls are needed, request the room's current self-service contract with `[[DEX:CMD {"action":"onboard"}]]`; do not guess resource IDs or supported actions.
- In a fresh room, the selected middle agent may request `workspace_ensure`. Nexus may create or reuse one EveOS-rooted managed PowerShell target, but this grants no execution, file-write, approval, or publication authority.
- After provisioning, use the returned exact room, Machine Space, terminal, and process epoch. Never recreate resources merely because a prior receipt reports them unavailable.
- TLO may still rely on Search Monitor as its delivery transport while the model runs locally. Treat an unavailable transport separately from a missing model or failed command.
- Use `use_room` with the `room` field. Before diagnosing a failure, request the exact job/terminal status and output receipt; label unsupported explanations as hypotheses.
