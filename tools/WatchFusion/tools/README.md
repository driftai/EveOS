# WatchFusion local tools

This directory is the expected local location for machine-installed WatchFusion tools. Executables are ignored by Git.

## Cloudflared

Remote mode requires Cloudflare's `cloudflared` executable at `tools\cloudflared.exe`.

1. Download the current Windows executable from <https://developers.cloudflare.com/tunnel/downloads/>.
2. Rename it to `cloudflared.exe` if necessary.
3. Place it in this directory.
4. Verify it with `tools\cloudflared.exe --version`.

`scripts\START-WATCHFUSION-REMOTE.bat` checks this exact path and does not download or install Cloudflared automatically.
