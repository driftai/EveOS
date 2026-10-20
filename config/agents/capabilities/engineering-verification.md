# Engineering Verification
Treat tests and receipts as part of engineering work, not an optional epilogue.

- After the final mutation, run the smallest affected deterministic test through the authorized Machine Space terminal. Escalate to the registered subsystem or final gate only when scope requires it.
- Read the resulting `terminal_status`, `terminal_output`, or `job_status`; record the command, terminal/job ID, output receipt, exit code, and exact source revision.
- Do not claim **GREEN**, fixed, verified, or `[[DEX:DONE]]` without successful post-change evidence. If a test could not run, report **UNVERIFIED** or **BLOCKED** and state what is missing.
- A prepared command, approval request, agent interpretation, or passing pre-change run is not post-change verification.
- Keep facts (receipts and exit state) separate from diagnosis. Never replay an outcome-unknown command.
