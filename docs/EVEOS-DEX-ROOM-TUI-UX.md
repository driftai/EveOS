# Dex TUI Conversation and Local Launcher — v0.7.1B

Scope: small presentation-and-access slice on `eve/nexus-machine-spaces` following `f582b610`.

- TUI chat now starts one read-only watcher per accepted message. It displays the final response after the **existing** Dex durable `finalReceipts` confirms the response. No second message or agent command is sent on timeout/reconnect.
- Default screen shows ordinary dialogue and short status only. `/details` reveals the latest technical request/receipt, `/details on|off` changes verbose display, `/ids` shows same-session send identifiers, `/check` and `/wait` retain manual exact-ID inspection, and `/history` loads bounded room transcript.
- Terminal operator's new `dex_terminal_room_send` accepts a human-originated message in any exact bound room with at least one enabled agent and no in-flight work. The **legacy** TLO-only `dex_terminal_send` route still enforces its old scope, and rooms tagged with `terminalBootstrap` remain TLO-only; TLO-only rooms require one live attached Machine Space.
- Nexus Dex Room sidebar adds **Open TUI** for the selected room. The browser sends a one-shot `dex_launch_room_tui` to a separate localhost, same-origin, `tui-launch` socket. On Windows, Nexus starts a fixed `powershell.exe` argument vector with `shell:false`, the known local Node executable, the known TUI script and one validated existing room ID. There is no arbitrary executable/argument selector and no permission elevation.
- This feature is not a grant to run terminal commands, publish source changes, use Playwright, or impersonate providers. Machine Spaces authorization, Dex routing, and Governor policy remain their original owners.

Acceptance: new TUI response tests, server launch security tests, ordinary-room send tests, existing terminal operator tests, Nexus suite, security suite, repository verify; live Windows click/open and live TLO receipt remain **UNQUALIFIED** until independently demonstrated. Back up and preserve runtime data.
