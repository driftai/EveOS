# Security & Privacy Policy — WatchFusion

WatchFusion is built with strict privacy, network containment, and SSRF boundaries.

---

## 1. Network Containment & Host Isolation

- **Default Loopback Binding**: Defaults to `127.0.0.1`. Binds `0.0.0.0` only when `--lan` or `HOST=0.0.0.0` is explicitly supplied.
- **Tunnel Diagnostics Redaction**: `/api/network-info` explicitly denies requests coming through Cloudflare tunnels (HTTP 403) to prevent local network enumeration.
- **Zero Host Filesystem Exposure**: Diagnostics endpoints (`/__nuvio__/diagnostics`) return pure metadata without leaking filesystem paths.

---

## 2. Room Identity & State Sanitization

- **Opaque Public Identifiers**: Internal member IDs and session account IDs are never exposed in public room state. All public state representations use detached random UUIDs.
- **Session Identity Binding**: Rejoining a room requires matching the original `accountId`. Mismatched reconnects are rejected with HTTP 409.

---

## 3. Server-Side Request Forgery (SSRF) Protection

- **DNS-Aware Validation**: `assertPublicHttpUrl()` validates all external media and Stremio addon proxy destinations.
- **Loopback & Private Subnet Blocking**: Rejects `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `198.18.0.0/15`, IPv6 `::1`, `fc00::/7`, `fe80::/10`, and IPv4-mapped IPv6 equivalents.
- **Credential & Header Stripping**: Addon proxy requests strip ambient `Authorization` headers, cookies, `Origin`, and `Referer` headers.
- **Redirect Traversal Protection**: Multi-hop HTTP redirects are re-validated on each step.

---

## 4. Static Filesystem Containment

- All static asset requests under `/` and `/nuvio/dist/` are validated with `isContainedPath()` to strictly prevent directory traversal attacks outside their respective roots.

---

## 5. External Nuvio Architecture

- Nuvio is treated as external user-installed data in `.\nuvio`.
- Git tracks only the placeholder `nuvio/.gitkeep`.
- User credentials and property overrides (`nuvio-wrapper.properties`, `local.properties`) are excluded by `.gitignore`.
