# Integration Smoke Layer

Environment-dependent checks belong here.

Planned coverage:
- LAN binding on `0.0.0.0`
- physical LAN address and canonical `sslip.io` host behavior
- cross-device room access
- local Cloudflare Quick Tunnel using `tools/cloudflared.exe`
- live YouTube playback as an optional integration test

These checks must report SKIPPED when their required environment is unavailable rather than failing the deterministic smoke suite.