"""HTML surfaces for the Audioflix Spotify relay and explicit file-tab approval flow."""
from __future__ import annotations

import html
import json


def relay_html(server_origin: str) -> str:
    origin_json = json.dumps(str(server_origin or ""))
    return f"""<!doctype html>
<meta charset=\"utf-8\">
<title>EveOS Spotify Relay</title>
<script>
(() => {{
  'use strict';
  const RELAY_ORIGIN = {origin_json};
  const PROTOCOL = 1;
  let port = null;
  let pairId = '';
  let clientToken = '';
  let clientId = '';
  let pollTimer = 0;
  const postJson = async (path, body) => {{
    const response = await fetch(path, {{
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: {{ 'Content-Type': 'application/json; charset=utf-8' }},
      body: JSON.stringify(body || {{}})
    }});
    let payload = {{}};
    try {{ payload = await response.json(); }} catch {{}}
    if (!response.ok) throw new Error(payload.reason || payload.message || `HTTP ${{response.status}}`);
    return payload;
  }};
  const send = (message) => {{ try {{ port?.postMessage(message); }} catch {{}} }};
  const publicGrant = (result) => ({{
    ok: result?.ok === true,
    connected: result?.connected === true,
    clientId: String(result?.clientId || ''),
    mode: String(result?.mode || ''),
    protocolVersion: Number(result?.protocolVersion || PROTOCOL),
    expiresIn: Number(result?.expiresIn || 0)
  }});
  const acceptGrant = (result) => {{
    if (!result?.connected || !result?.clientToken) throw new Error('Spotify relay did not receive a client capability.');
    clientToken = String(result.clientToken);
    clientId = String(result.clientId || '');
    send({{ type: 'ready', ...publicGrant(result) }});
  }};
  const pollPairing = async () => {{
    if (!pairId || clientToken) return;
    try {{
      const result = await postJson('/api/audioflix/spotify-client/pair-status', {{ pairId }});
      if (result?.approved && result?.connected) {{
        clearTimeout(pollTimer); pollTimer = 0;
        acceptGrant(result);
        return;
      }}
      if (result?.ok === false) throw new Error(result.reason || 'Pairing expired.');
    }} catch (error) {{
      send({{ type: 'connection-error', message: String(error?.message || error).slice(0, 240) }});
      return;
    }}
    pollTimer = setTimeout(pollPairing, 700);
  }};
  const connect = async (event, hello) => {{
    const parentOrigin = String(event.origin || '');
    const mode = parentOrigin === 'null' ? 'file' : 'localhost';
    const result = await postJson('/api/audioflix/spotify-client/connect', {{
      protocolVersion: PROTOCOL,
      parentOrigin,
      mode,
      documentId: String(hello.documentId || ''),
      libraryScopeId: String(hello.libraryScopeId || '')
    }});
    if (result?.pairingRequired) {{
      pairId = String(result.pairId || '');
      send({{
        type: 'pairing-required', ok: true,
        code: String(result.code || ''),
        approvalUrl: String(result.approvalUrl || ''),
        expiresIn: Number(result.expiresIn || 0)
      }});
      pollPairing();
      return;
    }}
    acceptGrant(result);
  }};
  window.addEventListener('message', (event) => {{
    if (event.source !== parent || port) return;
    const hello = event.data || {{}};
    if (hello.type !== 'eveos:spotify-relay-connect' || Number(hello.protocolVersion) !== PROTOCOL) return;
    const transferred = event.ports?.[0];
    if (!transferred) return;
    if (event.origin !== 'null' && event.origin !== RELAY_ORIGIN) {{
      transferred.postMessage({{ type: 'connection-error', message: 'Parent origin does not match the EveOS relay.' }});
      transferred.close();
      return;
    }}
    port = transferred;
    port.onmessage = async (messageEvent) => {{
      const message = messageEvent.data || {{}};
      if (message.type === 'disconnect') {{
        if (clientToken) {{
          try {{ await postJson('/api/audioflix/spotify-client/command', {{
            clientToken, command: {{ action: 'release', commandId: String(message.commandId || crypto.randomUUID()), clientCommandSeq: Number(message.clientCommandSeq || 1), payload: {{}} }}
          }}); }} catch {{}}
        }}
        try {{ port.close(); }} catch {{}}
        return;
      }}
      if (message.type !== 'command') return;
      if (!clientToken) {{
        send({{ type: 'result', requestId: message.requestId, result: {{ ok: false, approvalRequired: Boolean(pairId), reason: 'Spotify relay is not authorized yet.' }} }});
        return;
      }}
      try {{
        const result = await postJson('/api/audioflix/spotify-client/command', {{ clientToken, command: message.command || {{}} }});
        send({{ type: 'result', requestId: message.requestId, result }});
      }} catch (error) {{
        send({{ type: 'result', requestId: message.requestId, result: {{ ok: false, reason: String(error?.message || error).slice(0, 240) }} }});
      }}
    }};
    port.start?.();
    connect(event, hello).catch((error) => send({{ type: 'connection-error', message: String(error?.message || error).slice(0, 240) }}));
  }});
  parent.postMessage({{ type: 'eveos:spotify-relay-ready', protocolVersion: PROTOCOL }}, '*');
}})();
</script>"""


def approval_html(view: dict) -> str:
    if not view.get("ok"):
        reason = html.escape(str(view.get("reason") or "This pairing request is unavailable."))
        return f"""<!doctype html><meta charset=\"utf-8\"><title>EveOS Spotify approval</title>
<style>body{{font:16px system-ui;margin:3rem;max-width:46rem}}code{{font-size:1.4rem}}</style>
<h1>Spotify control request unavailable</h1><p>{reason}</p>"""
    pair_id = json.dumps(str(view.get("pairId") or ""))
    csrf = json.dumps(str(view.get("csrf") or ""))
    code = html.escape(str(view.get("code") or ""))
    expires = int(view.get("expiresIn") or 0)
    approved = bool(view.get("approved"))
    approved_text = "This request is already approved." if approved else "Confirm the same six-digit code is visible in the EveOS file tab before approving."
    return f"""<!doctype html>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>Approve EveOS Spotify control</title>
<style>
  body{{font:16px system-ui;margin:0;background:#111;color:#eee;min-height:100vh;display:grid;place-items:center}}
  main{{width:min(560px,90vw);padding:28px;border:1px solid #333;border-radius:16px;background:#181818}}
  code{{display:block;font-size:2rem;letter-spacing:.3em;margin:1rem 0}}
  button{{font:inherit;padding:.7rem 1rem;cursor:pointer}} #result{{margin-top:1rem}}
</style>
<main>
  <h1>Approve local EveOS Spotify control</h1>
  <p>{html.escape(approved_text)}</p>
  <code>{code}</code>
  <p>This approval expires in about {expires} seconds and authorizes only this pending file-document session.</p>
  <button id=\"approve\" {'disabled' if approved else ''}>Approve this EveOS file tab</button>
  <div id=\"result\">{'Approved.' if approved else ''}</div>
</main>
<script>
(() => {{
  const pairId = {pair_id};
  const csrf = {csrf};
  const button = document.getElementById('approve');
  const result = document.getElementById('result');
  button?.addEventListener('click', async () => {{
    button.disabled = true;
    result.textContent = 'Approving…';
    try {{
      const response = await fetch('/api/audioflix/spotify-client/approve', {{
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: {{ 'Content-Type': 'application/json; charset=utf-8' }},
        body: JSON.stringify({{ pairId, csrf }})
      }});
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.reason || 'Approval failed.');
      result.textContent = 'Approved. Return to the EveOS file tab.';
    }} catch (error) {{ result.textContent = String(error?.message || error); button.disabled = false; }}
  }});
}})();
</script>"""
