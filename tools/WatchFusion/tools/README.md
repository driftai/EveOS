# WatchFusion local tools

This directory is the expected local location for machine-installed WatchFusion tools. Executables are ignored by Git.

## Cloudflared

Remote mode uses Cloudflare's `cloudflared` executable at `tools\cloudflared.exe`.

When Remote mode is selected and `cloudflared` is not already available through `EVEOS_CLOUDFLARED`, `PATH`, or this directory, EveOS now downloads the current official Windows executable from Cloudflare's GitHub release channel and verifies that the downloaded program responds to `--version` before using it.

Official download documentation: <https://developers.cloudflare.com/tunnel/downloads/>.

You can still install it manually if preferred:

1. Download the current Windows executable from the official Cloudflare downloads page.
2. Rename it to `cloudflared.exe` if necessary.
3. Place it in this directory.
4. Verify it with `tools\cloudflared.exe --version`.

The downloaded executable is machine-local and ignored by EveOS Git.
