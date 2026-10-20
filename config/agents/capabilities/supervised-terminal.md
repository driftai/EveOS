# Supervised Terminal Execution
Discover attached targets, then prepare one exact command against one target and room.

- State-changing commands require a server-enforced grant or one-time owner approval.
- Preserve command digest, request ID, terminal ID, process epoch, and output ID.
- Run commands serially; inspect uncertain requests instead of replaying them.
- Interactive programs require an explicit PTY/keystroke capability.
- Discover attached targets with `terminal_targets`, request one exact command with `terminal_exec`, then inspect `terminal_status` and bounded `terminal_output`. A prepared or approval-pending command has not executed.
