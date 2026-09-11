# Security & Privacy Policy — WatchFusion

WatchFusion is designed as a local-first EveOS tool with explicit boundaries for host diagnostics, filesystem access, outbound media requests, and remote watch-party use.

## 1. Network containment & browser-origin policy

- **Default loopback binding:** the service defaults to `127.0.0.1`. It binds `0.0.0.0` only when LAN mode is explicitly requested.
- **Cross-origin API access is not wildcarded:** API CORS reflects only HTTP(S) origins whose hostname matches the WatchFusion request hostname. The only `null`-origin exception is the read-only `/api/health` probe used by EveOS `file://` mode.
- **Host diagnostics are truly host-local:** `/api/network-info` requires a loopback socket, a recognized local WatchFusion hostname, and a non-cross-site browser context. Cloudflare-forwarded and LAN-client requests are denied.
- **Setup diagnostics and installers are host-local:** `/api/setup/status` and `/api/setup/install` are unavailable to tunnel/LAN viewers. Install actions also remain Windows-only.
- **Nuvio diagnostics are host-local:** `/__nuvio__/diagnostics` and its compatibility alias do not expose backend/setup metadata to remote viewers.
- **VoxelVision host details are redacted remotely:** remote/LAN viewers receive no host CPU model, RAM amount, GPU names, tool-provider paths, or YouTube-helper providers. Host-side YouTube import is denied outside a host-local request.

## 2. Filesystem containment

- Main WatchFusion static assets are served only after both lexical containment and filesystem `realpath` containment under the WatchFusion `public/` root. A symlink/junction resolving outside that root is rejected.
- The generated `/app.js` bundle reads only its explicit client-file allowlist, and each source file is realpath-checked under `public/` before being read.
- Nuvio assets under `/nuvio/dist/` are realpath-checked to remain inside the selected Nuvio `dist` root.
- VoxelVision assets under `/voxelvision/` are realpath-checked to remain inside VoxelVision's public root.
- Imported VoxelVision media lives under `voxelvision/public/media/imported/` and is ignored by Git.
- WatchFusion does not expose arbitrary host filesystem paths through a generic file-serving endpoint.

## 3. Room identity & state sanitization

- **Opaque public identifiers:** internal member IDs and session account IDs are not emitted in public room state. Public member IDs are detached random UUIDs.
- **Session identity binding:** rejoining with an existing internal member ID requires the original account identity; mismatches are rejected.
- Room/chat state is kept in memory by the WatchFusion process unless another explicit persistence layer is added later.

## 4. SSRF and outbound request boundaries

- External media and addon targets are limited to HTTP(S) URLs without embedded credentials.
- `assertPublicHttpUrl()` rejects loopback, link-local, private RFC1918-style ranges, carrier-grade NAT ranges, multicast/reserved ranges, IPv6 loopback/link-local/ULA/multicast, and IPv4-mapped loopback/private forms covered by the validator.
- Nuvio addon proxy targets must use HTTPS and match recognized addon API paths.
- Redirects handled by WatchFusion media/addon proxy code are revalidated before the next hop.
- Ambient browser credentials are not forwarded to addon targets; proxy requests construct a small explicit outbound header set.

### Important remote-use boundary

Remote WatchFusion playback intentionally makes **server-side outbound requests to public media/addon hosts**. That means an upstream public server contacted by WatchFusion can see the public IP address of the machine/network running WatchFusion. Remote participants should not be able to turn those proxy paths into LAN/loopback/filesystem access, but the host is still the network egress point for supported remote media requests.

Use LAN or Cloudflare sharing only with people you trust, stop the tunnel when the room is finished, and do not treat a Quick Tunnel URL as an authentication secret.

## 5. External Nuvio architecture

- Nuvio is user-installed under `.\nuvio` or an explicit `NUVIO_PATH`; the EveOS repository tracks only `nuvio/.gitkeep`.
- WatchFusion setup currently installs from the canonical `NuvioMedia/NuvioTVSmart` repository; older documentation may refer to the historical `NuvioMedia/NuvioWeb` URL.
- `nuvio-wrapper.properties`, `nuvio-wrapper.local.properties`, `local.properties`, `.env*`, and `NUVIO_PATH.txt` are ignored.
- The generated browser environment exposes only the explicit `PUBLIC_ENV_KEYS` allowlist. Nuvio's Supabase **anon/publishable** key is intentionally browser-public; private service-role credentials must never be placed there.

## 6. What this policy does not claim

No static review can prove a networked application is vulnerability-free. In particular, dependency vulnerabilities, browser changes, DNS-rebinding/validation-to-connect timing edge cases, newly introduced routes, and local machine configuration still need regression testing. Run WatchFusion's security smoke profile and the EveOS verification suite after security-sensitive changes.
